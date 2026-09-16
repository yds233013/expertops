import { formatDateTime, formatRelative } from '@/lib/time';
import { type WorkerHealth } from '@/server/services/worker-health';
import { Badge, Card, EmptyState } from '@/components/ui';

/**
 * Whether automation is actually running.
 *
 * "No jobs pending" and "no worker running" produce the same empty queue, and
 * the second one is an outage. This panel exists to make them different things
 * on screen.
 */
export function WorkerHealthPanel({ health }: { health: WorkerHealth }) {
  const critical = health.warnings.filter((warning) => warning.severity === 'critical');

  return (
    <Card
      title="Is automation running?"
      description="A quiet queue and a dead worker look identical from the job list. This says which one it is."
      actions={
        health.noLiveWorker ? (
          <Badge tone="danger">no live worker</Badge>
        ) : (
          <Badge tone="success">
            {health.workers.filter((worker) => !worker.stalled).length} worker(s) reporting
          </Badge>
        )
      }
    >
      <div className="space-y-4">
        {health.warnings.length === 0 ? (
          <p className="alert alert-success">
            A worker is reporting in, nothing is overdue, and no job has exhausted its retries.
          </p>
        ) : (
          <ul className="space-y-2">
            {health.warnings.map((warning) => (
              <li
                key={warning.title}
                className={
                  warning.severity === 'critical'
                    ? 'rounded-md border border-rose-200 bg-rose-50 px-3 py-2'
                    : 'rounded-md border border-amber-200 bg-amber-50 px-3 py-2'
                }
              >
                <p
                  className={
                    warning.severity === 'critical'
                      ? 'text-sm font-semibold text-rose-900'
                      : 'text-sm font-semibold text-amber-900'
                  }
                >
                  {warning.title}
                </p>
                <p className="mt-0.5 text-sm text-ink-700">{warning.detail}</p>
                <p className="mt-1 text-xs font-medium text-ink-600">{warning.nextAction}</p>
              </li>
            ))}
          </ul>
        )}

        {health.workers.length === 0 ? (
          <EmptyState
            title="No worker has ever reported in"
            hint="Run `npm run worker` in a second terminal."
          />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Worker</th>
                  <th scope="col">State</th>
                  <th scope="col">Last heartbeat</th>
                  <th scope="col">Running since</th>
                  <th scope="col">Ticks</th>
                  <th scope="col">Last tick</th>
                </tr>
              </thead>
              <tbody>
                {health.workers.map((worker) => (
                  <tr key={worker.name}>
                    <td>
                      <code className="text-xs">{worker.name}</code>
                      <div className="text-xs text-ink-500">pid {worker.pid}</div>
                    </td>
                    <td>
                      <Badge tone={worker.stalled ? 'danger' : 'success'}>
                        {worker.stalled ? 'stalled' : 'alive'}
                      </Badge>
                    </td>
                    <td className="text-xs" title={formatDateTime(worker.lastSeenAt)}>
                      {worker.secondsSinceSeen}s ago
                    </td>
                    <td className="text-xs text-ink-500" title={formatDateTime(worker.startedAt)}>
                      {formatRelative(worker.startedAt)}
                    </td>
                    <td className="tabular-nums">{worker.ticks}</td>
                    <td className="max-w-72 text-xs">
                      {worker.lastError ? (
                        <span className="text-rose-700">{worker.lastError}</span>
                      ) : (
                        <span className="text-ink-400">no error</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {critical.length > 0 && (
          <p className="text-xs text-ink-600">
            While no worker is running, nothing in the application sends itself. Invitations stay in
            DRAFT, screening links are never delivered to the simulated outbox, and every scheduled
            sweep is simply not happening.
          </p>
        )}
      </div>
    </Card>
  );
}
