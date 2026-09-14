import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDateTime, formatRelative } from '@/lib/time';
import { requireOperator } from '@/server/http/context';
import { roleHasCapability } from '@/server/auth/permissions';
import { listSupportRequests, supportCounts } from '@/server/services/support';
import { SupportThread } from '@/components/support-thread';
import { Badge, Card, EmptyState, StatTile, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Support conversations, whole threads rather than a queue of subjects.
 *
 * The blocker a request is linked to is shown next to the thread, because a
 * request that blocks readiness or delivery is not just correspondence: it is
 * the reason a project is stuck.
 */
export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; blocking?: string }>;
}) {
  const operator = await requireOperator();
  const filters = await searchParams;

  const [requests, counts, owners] = await Promise.all([
    listSupportRequests(prisma, {
      status: filters.status as never,
      blockingOnly: filters.blocking === 'true',
    }),
    supportCounts(prisma),
    prisma.user.findMany({
      where: { isActive: true, role: { in: ['OPERATOR', 'ADMIN'] } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const canRespond = roleHasCapability(operator.role, 'support:respond');

  const tabs = [
    { label: 'All', href: '/support', active: !filters.status && filters.blocking !== 'true' },
    {
      label: 'Waiting on us',
      href: '/support?status=WAITING_ON_OPS',
      active: filters.status === 'WAITING_ON_OPS',
    },
    { label: 'Open', href: '/support?status=OPEN', active: filters.status === 'OPEN' },
    {
      label: 'Blocking work',
      href: '/support?blocking=true',
      active: filters.blocking === 'true',
    },
  ];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="page-title">Support</h1>
        <p className="mt-1 text-sm text-ink-600">
          Conversations with experts. Internal notes stay on this side; everything else appears in
          the expert&rsquo;s portal.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Open" value={counts.OPEN} />
        <StatTile label="Waiting on us" value={counts.WAITING_ON_OPS} tone="warning" />
        <StatTile label="Waiting on expert" value={counts.WAITING_ON_EXPERT} />
        <StatTile label="Resolved" value={counts.RESOLVED} tone="success" />
      </div>

      <nav className="flex flex-wrap gap-2" aria-label="Support filters">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={tab.active ? 'page' : undefined}
            className={
              tab.active
                ? 'rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-white'
                : 'rounded-md border border-ink-200 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-100'
            }
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {requests.length === 0 ? (
        <Card>
          <EmptyState title="No support requests match this filter" />
        </Card>
      ) : (
        <div className="space-y-4">
          {requests.map((request) => (
            <Card
              key={request.id}
              title={request.subject}
              description={`${request.reference} · ${request.expert.fullName} · ${request.category.replace(/_/g, ' ').toLowerCase()}`}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  {request.blocksReadiness && <Badge tone="danger">blocks readiness</Badge>}
                  {request.blocksDelivery && <Badge tone="danger">blocks delivery</Badge>}
                  <StatusBadge status={request.status} />
                </div>
              }
            >
              <div className="space-y-3">
                <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-600">
                  <div>
                    <dt className="inline font-semibold">Owner: </dt>
                    <dd className="inline">{request.owner?.name ?? 'unassigned'}</dd>
                  </div>
                  <div>
                    <dt className="inline font-semibold">Expert: </dt>
                    <dd className="inline">
                      <Link
                        className="text-accent-600 hover:underline"
                        href={`/experts/${request.expert.id}`}
                      >
                        {request.expert.reference}
                      </Link>
                    </dd>
                  </div>
                  {request.project && (
                    <div>
                      <dt className="inline font-semibold">Project: </dt>
                      <dd className="inline">
                        <Link
                          className="text-accent-600 hover:underline"
                          href={`/projects/${request.project.id}`}
                        >
                          {request.project.code}
                        </Link>
                      </dd>
                    </div>
                  )}
                  {request.responseDueAt && !request.firstRespondedAt && (
                    <div>
                      <dt className="inline font-semibold">First response due: </dt>
                      <dd className="inline" title={formatDateTime(request.responseDueAt)}>
                        {formatRelative(request.responseDueAt)}
                      </dd>
                    </div>
                  )}
                </dl>

                <p className="rounded-md bg-white px-3 py-2 text-sm text-ink-800 ring-1 ring-ink-200">
                  <span className="text-xs font-semibold text-ink-500">
                    {request.expert.fullName} wrote
                  </span>
                  <br />
                  <span className="whitespace-pre-line">{request.message}</span>
                </p>

                <SupportThread
                  requestId={request.id}
                  reference={request.reference}
                  status={request.status}
                  ownerId={request.ownerId}
                  owners={owners}
                  canRespond={canRespond}
                  replies={request.replies.map((reply) => ({
                    id: reply.id,
                    authorType: reply.authorType,
                    authorName:
                      reply.authorType === 'OPERATOR' ? 'ExpertOps' : request.expert.fullName,
                    body: reply.body,
                    internalOnly: reply.internalOnly,
                    createdAt: reply.createdAt.toISOString(),
                  }))}
                />

                {request.resolvedAt && (
                  <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                    Resolved {formatDateTime(request.resolvedAt)}. The closing note is the last
                    reply above, so the expert sees the same explanation.
                  </p>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
