import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDate, formatRelative } from '@/lib/time';
import { requireOperator } from '@/server/http/context';
import { roleHasCapability } from '@/server/auth/permissions';
import { listWorkItems, workCounts } from '@/server/services/work';
import { listSupportRequests, supportCounts } from '@/server/services/support';
import { listOffboardingTasks, offboardingCounts } from '@/server/services/offboarding';
import { AssignWorkPanel } from '@/components/assign-work-panel';
import { ReviewWorkPanel } from '@/components/review-work-panel';
import { AssignOffboardingTask } from '@/components/assign-offboarding-task';
import { ConfirmOffboardingTask } from '@/components/confirm-offboarding-task';
import { Badge, Card, EmptyState, ProvenanceTag, StatTile, StatusBadge } from '@/components/ui';
import { type WorkItemStatus } from '@prisma/client';

export const dynamic = 'force-dynamic';

const STATUSES: WorkItemStatus[] = [
  'ASSIGNED',
  'SUBMITTED',
  'REVISION_REQUESTED',
  'APPROVED',
  'CANCELLED',
];

export default async function DeliveryPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const operator = await requireOperator();
  const params = await searchParams;
  const status = STATUSES.includes(params.status as WorkItemStatus)
    ? (params.status as WorkItemStatus)
    : undefined;

  const [items, counts, support, supportTotals, offboarding, offboardingTotals] = await Promise.all(
    [
      listWorkItems(prisma, { status, limit: 100 }),
      workCounts(prisma),
      listSupportRequests(prisma, { limit: 50 }),
      supportCounts(prisma),
      listOffboardingTasks(prisma, { status: 'PENDING', limit: 50 }),
      offboardingCounts(prisma),
    ],
  );

  const confirmedSeats = await prisma.assignment.findMany({
    where: { status: 'CONFIRMED' },
    include: {
      project: { select: { code: true, title: true } },
      expert: { select: { fullName: true } },
    },
    orderBy: { confirmedAt: 'desc' },
    take: 100,
  });

  const canWrite = roleHasCapability(operator.role, 'work:write');
  const canReview = roleHasCapability(operator.role, 'work:review');
  const canConfirm = roleHasCapability(operator.role, 'offboarding:confirm');
  const canAssign = roleHasCapability(operator.role, 'offboarding:assign');
  const operators = await prisma.user.findMany({
    where: { isActive: true, role: { in: ['OPERATOR', 'ADMIN'] } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const unassignedTasks = offboarding.filter((task) => !task.ownerId);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold text-ink-900">Delivery</h1>
        <p className="mt-1 text-sm text-ink-600">
          Work items, expert support and offboarding. A review judges one submission; it never
          changes an expert&rsquo;s standing in the network.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Awaiting review"
          value={counts.SUBMITTED + counts.IN_REVIEW}
          tone="warning"
          hint="operator action"
        />
        <StatTile label="With the expert" value={counts.ASSIGNED + counts.REVISION_REQUESTED} />
        <StatTile label="Approved" value={counts.APPROVED} tone="success" />
        <StatTile
          label="Blocking support"
          value={supportTotals.blocking}
          tone={supportTotals.blocking > 0 ? 'danger' : 'neutral'}
        />
      </div>

      {canWrite && (
        <Card
          title="Assign work"
          description="Only a confirmed seat can receive work."
          actions={<ProvenanceTag kind="operator" />}
        >
          <AssignWorkPanel
            assignments={confirmedSeats.map((assignment) => ({
              id: assignment.id,
              label: `${assignment.project.code} · ${assignment.expert.fullName}`,
            }))}
          />
        </Card>
      )}

      <form className="card flex flex-wrap items-end gap-3 px-4 py-3" method="get">
        <div className="w-56">
          <label className="label" htmlFor="status">
            Work status
          </label>
          <select id="status" name="status" className="select" defaultValue={status ?? ''}>
            <option value="">All</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, ' ').toLowerCase()} ({counts[value]})
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-secondary" type="submit">
          Apply
        </button>
      </form>

      <Card
        title={`Work items (${items.length})`}
        description="Approving sets the quantity payment preparation will read."
        actions={<ProvenanceTag kind="operator" />}
      >
        {items.length === 0 ? (
          <EmptyState
            title="No work items"
            hint="Create one from a confirmed seat on a project page."
          />
        ) : (
          <div className="space-y-3">
            {items.map((item) => (
              <div key={item.id} className="rounded-lg border border-ink-200 px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-ink-500">{item.reference}</span>
                      <h3 className="text-sm font-semibold text-ink-900">{item.title}</h3>
                      <StatusBadge status={item.status} />
                      <Badge tone="muted">{item.basis.toLowerCase()}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-ink-500">
                      <Link
                        className="text-accent-600 hover:underline"
                        href={`/experts/${item.expert.id}`}
                      >
                        {item.expert.fullName}
                      </Link>
                      {' · '}
                      <Link
                        className="text-accent-600 hover:underline"
                        href={`/projects/${item.project.id}`}
                      >
                        {item.project.code}
                      </Link>
                      {item.dueAt ? ` · due ${formatDate(item.dueAt)}` : ''}
                      {` · revision ${item.currentRevision}`}
                    </p>
                    {item.submissions[0] && (
                      <p className="mt-1 text-xs text-ink-600">
                        Last submitted {formatRelative(item.submissions[0].submittedAt)}
                        {item.submissions[0].hoursClaimed
                          ? `, claiming ${item.submissions[0].hoursClaimed.toString()} hours`
                          : ''}
                      </p>
                    )}
                    {item.paymentItem && (
                      <p className="mt-1 text-xs text-ink-600">
                        Payment {item.paymentItem.reference} (
                        {item.paymentItem.status.toLowerCase()})
                      </p>
                    )}
                  </div>

                  {canReview && (item.status === 'SUBMITTED' || item.status === 'IN_REVIEW') ? (
                    <ReviewWorkPanel
                      workItemId={item.id}
                      reference={item.reference}
                      basis={item.basis}
                      claimedQuantity={item.submissions[0]?.hoursClaimed?.toString() ?? null}
                    />
                  ) : (
                    <Link
                      className="btn btn-secondary btn-sm"
                      href={`/projects/${item.project.id}`}
                    >
                      Open project
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title={`Support requests (${support.length})`}
        description="Experts see only their own requests, and never an internal note."
      >
        {support.length === 0 ? (
          <EmptyState title="No support requests" />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Expert</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Category</th>
                  <th scope="col">Status</th>
                  <th scope="col">Blocking</th>
                  <th scope="col">Response due</th>
                </tr>
              </thead>
              <tbody>
                {support.map((request) => (
                  <tr key={request.id}>
                    <td className="font-mono text-xs">{request.reference}</td>
                    <td>
                      <Link
                        className="text-accent-600 hover:underline"
                        href={`/experts/${request.expert.id}`}
                      >
                        {request.expert.fullName}
                      </Link>
                    </td>
                    <td className="text-ink-800">{request.subject}</td>
                    <td className="text-ink-600">
                      {request.category.replace(/_/g, ' ').toLowerCase()}
                    </td>
                    <td>
                      <StatusBadge status={request.status} />
                    </td>
                    <td>
                      {request.blocksReadiness || request.blocksDelivery ? (
                        <Badge tone="danger">
                          {[
                            request.blocksReadiness && 'readiness',
                            request.blocksDelivery && 'delivery',
                          ]
                            .filter(Boolean)
                            .join(' + ')}
                        </Badge>
                      ) : (
                        <span className="text-xs text-ink-400">no</span>
                      )}
                    </td>
                    <td className="text-xs text-ink-600">
                      {request.firstRespondedAt
                        ? `answered ${formatRelative(request.firstRespondedAt)}`
                        : request.responseDueAt
                          ? formatRelative(request.responseDueAt)
                          : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title={`Offboarding tasks awaiting confirmation (${offboarding.length})`}
        description="ExpertOps cannot verify any of these. Confirming records that a named operator says they did it."
        actions={
          <div className="flex items-center gap-2">
            {offboardingTotals.unassigned > 0 && (
              <Badge tone="warning">{offboardingTotals.unassigned} unassigned</Badge>
            )}
            <ProvenanceTag kind="operator" />
          </div>
        }
      >
        {offboarding.length === 0 ? (
          <EmptyState
            title="Nothing awaiting confirmation"
            hint={`${offboardingTotals.CONFIRMED} task(s) confirmed so far.`}
          />
        ) : (
          <>
            {unassignedTasks.length > 0 && (
              <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {unassignedTasks.length} task
                {unassignedTasks.length === 1 ? ' has' : 's have'} no owner. Checklists opened
                automatically when a project closes start unassigned, because the worker is not a
                person who can be accountable for one. Give each an owner below.
              </p>
            )}
            <ul className="space-y-2">
              {offboarding.map((task) => (
                <li
                  key={task.id}
                  className={
                    task.ownerId
                      ? 'rounded-lg border border-ink-200 px-3 py-2'
                      : 'rounded-lg border border-amber-200 bg-amber-50/40 px-3 py-2'
                  }
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-ink-900">{task.label}</p>
                      <p className="text-xs text-ink-500">{task.description}</p>
                      <p className="mt-1 text-xs text-ink-600">
                        {task.expert.fullName} · {task.project.code}
                        {task.dueAt ? ` · due ${formatRelative(task.dueAt)}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <AssignOffboardingTask
                        taskId={task.id}
                        ownerId={task.ownerId}
                        owners={operators}
                        canAssign={canAssign}
                      />
                      {canConfirm && <ConfirmOffboardingTask taskId={task.id} label={task.label} />}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}
