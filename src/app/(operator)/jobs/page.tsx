import { prisma } from '@/lib/db';
import { formatDateTime, formatRelative } from '@/lib/time';
import { roleHasCapability } from '@/server/auth/permissions';
import { requireOperator } from '@/server/http/context';
import { jobCounts, listJobs } from '@/server/services/jobs';
import { listSchedules, scheduleDescription } from '@/server/services/schedules';
import { describeJobOutcome } from '@/lib/job-outcome';
import { ActionButton } from '@/components/action-button';
import { Badge, Card, EmptyState, ProvenanceTag, StatTile, StatusBadge } from '@/components/ui';
import { type JobStatus } from '@prisma/client';

export const dynamic = 'force-dynamic';

const STATUSES: JobStatus[] = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD', 'CANCELLED'];

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; type?: string }>;
}) {
  const operator = await requireOperator();
  const params = await searchParams;
  const status = STATUSES.includes(params.status as JobStatus)
    ? (params.status as JobStatus)
    : undefined;

  const [{ jobs }, counts, schedules] = await Promise.all([
    listJobs(prisma, { status, type: params.type || undefined, limit: 80 }),
    jobCounts(prisma),
    listSchedules(prisma),
  ]);

  const canManage = roleHasCapability(operator.role, 'jobs:manage');

  return (
    <div className="space-y-5">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-ink-900">Background worker</h1>
          <ProvenanceTag kind="automated" />
        </div>
        <p className="mt-1 text-sm text-ink-600">
          Jobs and schedules live in PostgreSQL. Workers claim rows with{' '}
          <code>FOR UPDATE SKIP LOCKED</code>, so several can run at once and a restart never loses
          or repeats work. Start one with <code>npm run worker</code>.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {STATUSES.map((value) => (
          <StatTile
            key={value}
            label={value.toLowerCase()}
            value={counts[value]}
            tone={value === 'DEAD' ? 'danger' : value === 'FAILED' ? 'warning' : 'neutral'}
          />
        ))}
      </div>

      <Card
        title="Schedules"
        description="Each tick enqueues one job, deduplicated by name and second."
      >
        <div className="scroll-x">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Job type</th>
                <th>Interval</th>
                <th>Enabled</th>
                <th>Last run</th>
                <th>Next run</th>
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
                  <td>
                    <StatusBadge status={schedule.enabled ? 'ACTIVE' : 'CANCELLED'} />
                  </td>
                  <td className="text-ink-600">{formatRelative(schedule.lastRunAt)}</td>
                  <td className="text-ink-600">{formatRelative(schedule.nextRunAt)}</td>
                  <td className="text-ink-600">{scheduleDescription(schedule.name)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <form className="card flex flex-wrap items-end gap-3 px-4 py-3" method="get">
        <div className="w-48">
          <label className="label" htmlFor="status">
            Status
          </label>
          <select id="status" name="status" className="select" defaultValue={status ?? ''}>
            <option value="">All</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.toLowerCase()} ({counts[value]})
              </option>
            ))}
          </select>
        </div>
        <div className="w-56">
          <label className="label" htmlFor="type">
            Type
          </label>
          <input
            id="type"
            name="type"
            className="input"
            defaultValue={params.type ?? ''}
            placeholder="invitation.send"
          />
        </div>
        <button className="btn btn-secondary" type="submit">
          Apply
        </button>
      </form>

      <Card title={`${jobs.length} job${jobs.length === 1 ? '' : 's'}`}>
        {jobs.length === 0 ? (
          <EmptyState title="No jobs match that filter" hint="Is the worker running?" />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Run at</th>
                  <th>Worker</th>
                  <th>What it did</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <code className="text-xs">{job.type}</code>
                      <div className="text-[0.7rem] text-ink-400">
                        {formatRelative(job.createdAt)}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="tabular-nums">
                      {job.attempts}/{job.maxAttempts}
                    </td>
                    <td
                      className="whitespace-nowrap text-xs text-ink-500"
                      title={formatDateTime(job.runAt)}
                    >
                      {formatRelative(job.runAt)}
                    </td>
                    <td className="text-xs text-ink-500">{job.lockedBy ?? '—'}</td>
                    <td className="max-w-80 text-xs">
                      {job.lastError ? (
                        <span className="text-rose-700">{job.lastError}</span>
                      ) : job.result ? (
                        (() => {
                          // "Succeeded" answers whether it ran. This answers
                          // whether anything happened, which is the question an
                          // operator is actually asking.
                          const outcome = describeJobOutcome(job.result);
                          return (
                            <div className="space-y-1">
                              {outcome.summary && (
                                <Badge tone={outcome.effect === 'effect' ? 'success' : 'muted'}>
                                  {outcome.summary}
                                </Badge>
                              )}
                              <code className="block text-ink-500">
                                {JSON.stringify(job.result)}
                              </code>
                            </div>
                          );
                        })()
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td>
                      {canManage && ['DEAD', 'FAILED', 'CANCELLED'].includes(job.status) ? (
                        <ActionButton url={`/api/jobs/${job.id}/retry`} label="Retry" />
                      ) : (
                        <span className="text-xs text-ink-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
