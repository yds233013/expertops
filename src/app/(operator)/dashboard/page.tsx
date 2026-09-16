import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireOperator } from '@/server/http/context';
import { formatDateTime, formatRelative } from '@/lib/time';
import { listActivity } from '@/server/services/activity';
import { expertCountsByStatus } from '@/server/services/experts';
import { invitationCounts } from '@/server/services/invitations';
import { onboardingCounts } from '@/server/services/onboarding';
import { assignmentCounts } from '@/server/services/staffing';
import { workloadQueues } from '@/server/services/workload';
import { workerHealth } from '@/server/services/worker-health';
import { Card, EmptyState, PageHeader, StatTile, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

const OPEN_STATUSES = ['MATCHING', 'INVITING', 'STAFFING', 'ACTIVE'] as const;
const EXPERT_ORDER = [
  'PROSPECT',
  'ONBOARDING',
  'PENDING_VERIFICATION',
  'VERIFIED',
  'REJECTED',
  'ARCHIVED',
] as const;

/**
 * Where the day starts.
 *
 * The old dashboard led with four totals and gave most of its height to the
 * scheduler's configuration, which is reference material for an engineer. An
 * operator opening this wants to know what is waiting on them and how the
 * engagements are doing, so those come first, and the schedule lives on the
 * worker screen where it already was.
 */
export default async function DashboardPage() {
  // Guarded here as well as in the layout. A layout redirect is not an
  // authorisation boundary — the page's own queries run alongside it.
  await requireOperator();

  const [workload, experts, invitations, onboarding, assignments, projects, activity, health] =
    await Promise.all([
      workloadQueues(prisma),
      expertCountsByStatus(prisma),
      invitationCounts(prisma),
      onboardingCounts(prisma),
      assignmentCounts(prisma),
      prisma.project.findMany({
        where: { status: { in: [...OPEN_STATUSES] } },
        select: {
          id: true,
          code: true,
          title: true,
          clientName: true,
          status: true,
          seatsRequested: true,
          seatsFilled: true,
        },
        orderBy: [{ status: 'asc' }, { code: 'asc' }],
        take: 8,
      }),
      // Sign-ins and the one-off fixture rename are routine, and would otherwise
      // be most of a ten-line feed. Both remain in the full history.
      listActivity(prisma, {
        limit: 10,
        excludeActions: ['operator.signed_in', 'fixture.renamed'],
      }),
      workerHealth(prisma),
    ]);

  const waiting = workload.queues.filter((queue) => queue.count > 0);
  const clear = workload.queues.filter((queue) => queue.count === 0);
  const totalExperts = Object.values(experts).reduce((sum, count) => sum + count, 0);
  const seatsRequested = projects.reduce((sum, project) => sum + project.seatsRequested, 0);
  const seatsFilled = projects.reduce((sum, project) => sum + project.seatsFilled, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Today"
        title="Operator dashboard"
        description="What is waiting on a person, and how each open engagement is staffed."
        actions={
          <Link className="btn btn-primary" href="/attention">
            Open the attention queue
          </Link>
        }
      />

      {health.noLiveWorker && (
        <p className="alert alert-error" role="status">
          <strong>No background worker is running.</strong> Reminders, sweeps and the simulated
          outbox are paused until one starts.{' '}
          <Link className="font-semibold underline" href="/jobs">
            Worker screen
          </Link>
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Seats filled"
          value={
            <>
              {seatsFilled}
              <span className="text-base font-normal text-ink-400">/{seatsRequested}</span>
            </>
          }
          sub={`Across ${projects.length} open ${projects.length === 1 ? 'project' : 'projects'}`}
          href="/projects"
        />
        <StatTile
          label="Invitations out"
          value={invitations.SENT}
          sub={`${invitations.ACCEPTED} accepted so far`}
          href="/projects"
        />
        <StatTile
          label="Awaiting verification"
          value={onboarding.SUBMITTED}
          sub="Checklists submitted for review"
          href="/onboarding"
        />
        <StatTile
          label="Experts in the network"
          value={totalExperts}
          sub={`${experts.VERIFIED} verified · ${assignments.CONFIRMED} on a seat`}
          href="/experts"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Card
          flush
          title="Waiting on a person"
          description={
            waiting.length === 0
              ? 'Every queue is clear.'
              : `${waiting.length} of ${workload.queues.length} queues have something in them.`
          }
        >
          {waiting.length === 0 ? (
            <EmptyState glyph="✓" title="Nothing is waiting" hint="Queues fill on their own." />
          ) : (
            <ul className="divide-y divide-ink-100">
              {waiting.map((queue) => (
                <li key={queue.href}>
                  <Link
                    href={queue.href}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-ink-50"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink-900">
                        {queue.label}
                      </span>
                      <span className="block truncate text-xs text-ink-500">{queue.action}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-lg font-semibold tabular-nums text-ink-900">
                        {queue.count}
                      </span>
                      <span aria-hidden="true" className="text-ink-300">
                        ›
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {clear.length > 0 && (
            <p className="border-t border-ink-100 px-4 py-2.5 text-xs text-ink-500">
              Clear: {clear.map((queue) => queue.label.toLowerCase()).join(', ')}.
            </p>
          )}
        </Card>

        <Card
          flush
          title="Open projects"
          description="Seats are filled one explicit confirmation at a time."
          actions={
            <Link className="btn btn-secondary btn-sm" href="/projects">
              All projects
            </Link>
          }
        >
          {projects.length === 0 ? (
            <EmptyState
              title="No open projects"
              hint="A project opens for matching once its requirements are set."
              action={
                <Link className="btn btn-primary btn-sm" href="/projects/new">
                  New project
                </Link>
              }
            />
          ) : (
            <ul className="divide-y divide-ink-100">
              {projects.map((project) => {
                const pct =
                  project.seatsRequested > 0
                    ? Math.round((project.seatsFilled / project.seatsRequested) * 100)
                    : 0;
                return (
                  <li key={project.id}>
                    <Link
                      href={`/projects/${project.id}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-2.5 hover:bg-ink-50 sm:grid-cols-[minmax(0,1fr)_9rem_auto]"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-ink-900">
                          {project.title}
                        </span>
                        <span className="block truncate text-xs text-ink-500">
                          {project.code} · {project.clientName}
                        </span>
                      </span>
                      <span className="order-last col-span-2 flex items-center gap-2 sm:order-none sm:col-span-1">
                        <span
                          className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-100"
                          aria-hidden="true"
                        >
                          <span
                            className="block h-full rounded-full bg-accent-500"
                            style={{ width: `${pct}%` }}
                          />
                        </span>
                        <span className="w-12 text-right text-xs font-semibold tabular-nums text-ink-700">
                          {project.seatsFilled}/{project.seatsRequested}
                        </span>
                      </span>
                      <StatusBadge status={project.status} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Card
          title="Expert network"
          description="Where each person in the network is in their lifecycle."
        >
          <ul className="space-y-1">
            {EXPERT_ORDER.map((status) => (
              <li key={status}>
                <Link
                  href={`/experts?status=${status}`}
                  className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-1 hover:bg-ink-50"
                >
                  <StatusBadge status={status} />
                  <span className="text-sm font-semibold tabular-nums text-ink-800">
                    {experts[status]}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card
          title="Recent activity"
          description="Workflow changes, attributed to whoever made them. Sign-ins are left out here."
          actions={
            <Link className="btn btn-secondary btn-sm" href="/activity">
              Full history
            </Link>
          }
        >
          {activity.events.length === 0 ? (
            <EmptyState title="No activity recorded yet" />
          ) : (
            <ol className="space-y-2.5">
              {activity.events.map((event) => (
                <li key={event.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 text-sm">
                  <time
                    className="pt-px text-xs tabular-nums text-ink-500"
                    dateTime={event.createdAt.toISOString()}
                    title={formatDateTime(event.createdAt)}
                  >
                    {formatRelative(event.createdAt)}
                  </time>
                  <span className="min-w-0 text-ink-800">{event.summary}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
}
