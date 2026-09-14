import Link from 'next/link';
import { clsx } from 'clsx';
import { prisma } from '@/lib/db';
import { formatDateTime, formatRelative } from '@/lib/time';
import { requireOperator } from '@/server/http/context';
import { roleHasCapability } from '@/server/auth/permissions';
import { attentionCounts, listAttention } from '@/server/services/attention';
import { workerHealth } from '@/server/services/worker-health';
import { AttentionActions } from '@/components/attention-actions';
import { Badge, Card, EmptyState, PageHeader, StatTile } from '@/components/ui';
import { type AttentionKind, type AttentionSeverity } from '@prisma/client';

export const dynamic = 'force-dynamic';

/**
 * The operator's main working surface.
 *
 * Every row answers four questions: what is stuck, what it costs, who owns it,
 * and what to do next. Business blockers and automation failures are shown in
 * separate sections, because a broken job is an engineering problem and mixing
 * the two hides both.
 */
const SEVERITY_ORDER: AttentionSeverity[] = ['HIGH', 'MEDIUM', 'LOW'];

function severityTone(severity: AttentionSeverity) {
  return severity === 'HIGH' ? 'danger' : severity === 'MEDIUM' ? 'warning' : 'neutral';
}

export default async function AttentionPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; severity?: string; mine?: string; unassigned?: string }>;
}) {
  const operator = await requireOperator();
  const params = await searchParams;

  const kind = (params.kind as AttentionKind) || undefined;
  const severity = (params.severity as AttentionSeverity) || undefined;

  const [items, counts, operators, health] = await Promise.all([
    listAttention(prisma, {
      kind,
      severity,
      ownerId: params.mine === 'true' ? operator.id : undefined,
      unassignedOnly: params.unassigned === 'true',
      limit: 200,
    }),
    attentionCounts(prisma),
    prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    workerHealth(prisma),
  ]);

  const business = items.filter((item) => item.kind === 'BUSINESS_BLOCKER');
  const automation = items.filter((item) => item.kind === 'AUTOMATION_FAILURE');
  const canManage = roleHasCapability(operator.role, 'attention:manage');
  const now = new Date();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Needs attention"
        description="Everything that is stuck and needs a person. Items appear and disappear on their own as conditions change, so an empty list means nothing is waiting."
      />

      {/* An empty queue means nothing is waiting only if something is running to
          put things on it. A stalled worker is announced here, ahead of the
          list, because this is the screen an operator starts their day on. */}
      {health.warnings.length > 0 && (
        <section
          aria-labelledby="automation-health"
          className={
            health.noLiveWorker
              ? 'rounded-lg border border-rose-200 bg-rose-50 px-4 py-3'
              : 'rounded-lg border border-amber-200 bg-amber-50 px-4 py-3'
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2
              id="automation-health"
              className={
                health.noLiveWorker
                  ? 'text-sm font-semibold text-rose-900'
                  : 'text-sm font-semibold text-amber-900'
              }
            >
              {health.noLiveWorker ? 'Automation is not running' : 'Automation needs attention'}
            </h2>
            <Link className="text-xs font-medium text-accent-600 hover:underline" href="/jobs">
              Worker screen →
            </Link>
          </div>
          <ul className="mt-2 space-y-1">
            {health.warnings.map((warning) => (
              <li key={warning.title} className="text-sm text-ink-800">
                <span className="font-medium">{warning.title}.</span> {warning.nextAction}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Open items" value={counts.total} />
        <StatTile label="High severity" value={counts.high} tone="danger" hint="act first" />
        <StatTile label="Unassigned" value={counts.unassigned} tone="warning" hint="no owner" />
        <StatTile label="Overdue" value={counts.overdue} tone="danger" />
        <StatTile
          label="Automation failures"
          value={counts.automationFailures}
          tone={counts.automationFailures > 0 ? 'danger' : 'neutral'}
          hint="not business"
        />
      </div>

      <nav className="card flex flex-wrap items-center gap-2 px-4 py-3" aria-label="Filters">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">Filter</span>
        <FilterLink
          href="/attention"
          active={!kind && !severity && !params.mine && !params.unassigned}
        >
          Everything
        </FilterLink>
        <FilterLink href="/attention?mine=true" active={params.mine === 'true'}>
          Mine
        </FilterLink>
        <FilterLink href="/attention?unassigned=true" active={params.unassigned === 'true'}>
          Unassigned
        </FilterLink>
        {SEVERITY_ORDER.map((value) => (
          <FilterLink key={value} href={`/attention?severity=${value}`} active={severity === value}>
            {value.toLowerCase()}
          </FilterLink>
        ))}
      </nav>

      <Card
        title={`Business blockers (${business.length})`}
        description="Real-world problems an operator can unblock."
      >
        {business.length === 0 ? (
          <EmptyState
            title="Nothing is blocked"
            hint="New items appear here automatically when something gets stuck."
          />
        ) : (
          <ul className="space-y-3">
            {business.map((item) => {
              const overdue = item.dueAt !== null && item.dueAt.getTime() <= now.getTime();
              return (
                <li key={item.id} className={clsx('attn', `attn-${item.severity.toLowerCase()}`)}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={severityTone(item.severity)}>
                          {item.severity.toLowerCase()}
                        </Badge>
                        <h3 className="text-sm font-semibold text-ink-900">{item.title}</h3>
                        <code className="text-[0.7rem] text-ink-400">{item.category}</code>
                      </div>

                      <dl className="mt-2 space-y-1.5 text-sm">
                        <div className="flex gap-2">
                          <dt className="attn-term w-16 shrink-0 pt-0.5">Blocker</dt>
                          <dd className="text-ink-800">{item.blocker}</dd>
                        </div>
                        <div className="flex gap-2">
                          <dt className="attn-term w-16 shrink-0 pt-0.5">Impact</dt>
                          <dd className="text-ink-600">{item.impact}</dd>
                        </div>
                      </dl>

                      {/* Separated from the description above: everything else on
                          the card explains the situation, this is the instruction. */}
                      <p className="attn-next">
                        <span className="attn-term mr-2 text-accent-600">Do next</span>
                        {item.nextAction}
                      </p>

                      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
                        <span
                          className={clsx('owner-chip', !item.owner && 'owner-chip-unassigned')}
                        >
                          {item.owner ? item.owner.name : 'Unassigned'}
                        </span>
                        {overdue && <Badge tone="danger">overdue</Badge>}
                        <span className={overdue ? 'font-semibold text-rose-700' : 'text-ink-500'}>
                          {item.dueAt
                            ? `${overdue ? 'Overdue since' : 'Due'} ${formatRelative(item.dueAt)}`
                            : 'No due date'}
                        </span>
                        <span className="text-ink-400" title={formatDateTime(item.createdAt)}>
                          raised {formatRelative(item.createdAt)}
                        </span>
                      </div>

                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        {item.project && (
                          <Link
                            className="text-accent-600 hover:underline"
                            href={`/projects/${item.project.id}`}
                          >
                            {item.project.code}
                          </Link>
                        )}
                        {item.expert && (
                          <Link
                            className="text-accent-600 hover:underline"
                            href={`/experts/${item.expert.id}`}
                          >
                            {item.expert.fullName}
                          </Link>
                        )}
                        {item.candidate && (
                          <Link
                            className="text-accent-600 hover:underline"
                            href={`/candidates/${item.candidate.id}`}
                          >
                            {item.candidate.fullName}
                          </Link>
                        )}
                      </div>
                    </div>

                    {canManage && (
                      <AttentionActions
                        itemId={item.id}
                        currentOwnerId={item.ownerId}
                        operators={operators}
                        selfId={operator.id}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card
        title={`Automation failures (${automation.length})`}
        description="Jobs that stopped retrying. These are engineering problems, not business blockers, and are listed separately for that reason."
      >
        {automation.length === 0 ? (
          <EmptyState title="The automation is healthy" hint="No job has exhausted its retries." />
        ) : (
          <ul className="space-y-2">
            {automation.map((item) => (
              <li key={item.id} className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-rose-900">{item.title}</h3>
                    <p className="mt-1 text-sm text-rose-800">{item.blocker}</p>
                    <p className="mt-1 text-xs text-rose-700">{item.impact}</p>
                    <p className="mt-1 text-xs font-medium text-rose-900">{item.nextAction}</p>
                  </div>
                  <Link className="btn btn-secondary btn-sm" href="/jobs">
                    Open the worker screen
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={
        active
          ? 'rounded-md bg-accent-500 px-2.5 py-1 text-xs font-semibold text-white'
          : 'rounded-md border border-ink-200 px-2.5 py-1 text-xs text-ink-700 hover:bg-ink-100'
      }
    >
      {children}
    </Link>
  );
}
