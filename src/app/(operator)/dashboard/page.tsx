import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireOperator } from '@/server/http/context';
import { formatRelative } from '@/lib/time';
import { listActivity } from '@/server/services/activity';
import { expertCountsByStatus } from '@/server/services/experts';
import { invitationCounts } from '@/server/services/invitations';
import { jobCounts } from '@/server/services/jobs';
import { onboardingCounts } from '@/server/services/onboarding';
import { outboxCounts } from '@/server/services/outbox';
import { projectCountsByStatus } from '@/server/services/projects';
import { assignmentCounts } from '@/server/services/staffing';
import { listSchedules, scheduleDescription } from '@/server/services/schedules';
import { Card, EmptyState, ProvenanceTag, StatTile, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  // Guarded here as well as in the layout. A layout redirect is not an
  // authorisation boundary — the page's own queries run alongside it — and this
  // is the one page in the group that had nothing of its own.
  await requireOperator();

  const [
    experts,
    projects,
    invitations,
    onboarding,
    assignments,
    outbox,
    jobs,
    schedules,
    activity,
  ] = await Promise.all([
    expertCountsByStatus(prisma),
    projectCountsByStatus(prisma),
    invitationCounts(prisma),
    onboardingCounts(prisma),
    assignmentCounts(prisma),
    outboxCounts(prisma),
    jobCounts(prisma),
    listSchedules(prisma),
    listActivity(prisma, { limit: 12 }),
  ]);

  const openProjects = projects.MATCHING + projects.INVITING + projects.STAFFING;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Operator dashboard</h1>
        <p className="mt-1 text-sm text-ink-600">
          Pipeline state across sourcing, onboarding and staffing.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Open projects"
          value={openProjects}
          hint={`${projects.ACTIVE} active`}
          tone="success"
        />
        <StatTile
          label="Awaiting verification"
          value={onboarding.SUBMITTED}
          hint="operator action"
          tone="warning"
        />
        <StatTile
          label="Invitations out"
          value={invitations.SENT}
          hint={`${invitations.ACCEPTED} accepted`}
          tone="info"
        />
        <StatTile
          label="Seats confirmed"
          value={assignments.CONFIRMED}
          hint={`${assignments.PROPOSED} proposed`}
          tone="info"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Expert network" description="Lifecycle distribution across the network.">
          <dl className="space-y-1.5">
            {Object.entries(experts).map(([status, count]) => (
              <div key={status} className="flex items-center justify-between gap-3">
                <StatusBadge status={status} />
                <span className="text-sm font-semibold tabular-nums text-ink-800">{count}</span>
              </div>
            ))}
          </dl>
        </Card>

        <Card title="Projects" description="Where each engagement currently sits.">
          <dl className="space-y-1.5">
            {Object.entries(projects).map(([status, count]) => (
              <div key={status} className="flex items-center justify-between gap-3">
                <StatusBadge status={status} />
                <span className="text-sm font-semibold tabular-nums text-ink-800">{count}</span>
              </div>
            ))}
          </dl>
        </Card>

        <Card
          title="Background worker"
          description="PostgreSQL-backed queue. Run `npm run worker` alongside the app."
          actions={<ProvenanceTag kind="automated" />}
        >
          <dl className="space-y-1.5">
            {Object.entries(jobs).map(([status, count]) => (
              <div key={status} className="flex items-center justify-between gap-3">
                <StatusBadge status={status} />
                <span className="text-sm font-semibold tabular-nums text-ink-800">{count}</span>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 border-t border-ink-100 pt-2">
              <span className="text-xs text-ink-500">Simulated emails queued</span>
              <span className="text-sm font-semibold tabular-nums text-ink-800">
                {outbox.QUEUED}
              </span>
            </div>
          </dl>
        </Card>
      </div>

      <Card
        title="Scheduled jobs"
        description="Registered in the database and claimed by whichever worker ticks first."
        actions={<ProvenanceTag kind="automated" />}
      >
        {schedules.length === 0 ? (
          <EmptyState
            title="No schedules registered yet"
            hint="They are created the first time the worker boots."
          />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Schedule</th>
                  <th>Job type</th>
                  <th>Every</th>
                  <th>Next run</th>
                  <th>Last run</th>
                  <th>Purpose</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((schedule) => (
                  <tr key={schedule.id}>
                    <td className="font-medium text-ink-900">{schedule.name}</td>
                    <td>
                      <code className="text-xs">{schedule.jobType}</code>
                    </td>
                    <td className="tabular-nums">{schedule.intervalSeconds}s</td>
                    <td className="text-ink-600">{formatRelative(schedule.nextRunAt)}</td>
                    <td className="text-ink-600">{formatRelative(schedule.lastRunAt)}</td>
                    <td className="text-ink-600">{scheduleDescription(schedule.name)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Recent activity"
        description="Every workflow transition, attributed to the operator, expert or worker that caused it."
        actions={
          <Link className="btn btn-secondary btn-sm" href="/activity">
            View all
          </Link>
        }
      >
        {activity.events.length === 0 ? (
          <EmptyState title="No activity recorded yet" />
        ) : (
          <ol className="space-y-2">
            {activity.events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="text-xs tabular-nums text-ink-400">
                  {formatRelative(event.createdAt)}
                </span>
                <StatusBadge status={event.actorType} />
                <span className="text-ink-800">{event.summary}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
