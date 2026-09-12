import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';

/**
 * Is anything actually running?
 *
 * The queue tables answer "what work exists". They cannot answer "is a worker
 * alive", and the two look identical from the operator screen: a worker that
 * died leaves a quiet queue, exactly like a worker with nothing to do. The
 * difference only becomes visible later, when something overdue piles up and
 * somebody asks why nothing happened.
 *
 * So each worker writes a heartbeat row per tick, and this module turns the
 * absence of one into a warning a person can act on.
 */

/** A worker is called stalled once it has missed this many seconds. */
export const STALE_AFTER_SECONDS = 90;

/** A job due this long ago, still unclaimed, is called overdue. */
export const OVERDUE_AFTER_MINUTES = 10;

export async function recordHeartbeat(
  db: Db,
  input: { name: string; pid: number; startedAt: Date; ticks: number; lastError?: string | null },
  now: Date = clockNow(),
): Promise<void> {
  await db.workerHeartbeat.upsert({
    where: { name: input.name },
    update: {
      pid: input.pid,
      startedAt: input.startedAt,
      lastSeenAt: now,
      ticks: input.ticks,
      lastError: input.lastError ?? null,
    },
    create: {
      name: input.name,
      pid: input.pid,
      startedAt: input.startedAt,
      lastSeenAt: now,
      ticks: input.ticks,
      lastError: input.lastError ?? null,
    },
  });
}

export interface WorkerStatus {
  name: string;
  pid: number;
  startedAt: Date;
  lastSeenAt: Date;
  ticks: number;
  lastError: string | null;
  secondsSinceSeen: number;
  stalled: boolean;
}

export interface HealthWarning {
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
  /** What a person should actually do about it. */
  nextAction: string;
}

export interface WorkerHealth {
  workers: WorkerStatus[];
  /** True when no worker has reported recently, including when none ever has. */
  noLiveWorker: boolean;
  overdueJobs: number;
  oldestOverdueMinutes: number | null;
  deadJobs: number;
  runningPastLease: number;
  warnings: HealthWarning[];
}

/**
 * Everything the Worker screen needs to say whether automation is healthy.
 *
 * Deliberately one query set rather than a background checker: the answer has
 * to be true at the moment somebody looks at it, and a cached verdict about
 * liveness is the thing most likely to be wrong.
 */
export async function workerHealth(db: Db, now: Date = clockNow()): Promise<WorkerHealth> {
  const staleBefore = new Date(now.getTime() - STALE_AFTER_SECONDS * 1000);
  const overdueBefore = new Date(now.getTime() - OVERDUE_AFTER_MINUTES * 60_000);

  const [rows, overdue, oldestOverdue, deadJobs, runningPastLease] = await Promise.all([
    db.workerHeartbeat.findMany({ orderBy: { lastSeenAt: 'desc' } }),
    db.job.count({
      where: { status: { in: ['PENDING', 'FAILED'] }, runAt: { lt: overdueBefore } },
    }),
    db.job.findFirst({
      where: { status: { in: ['PENDING', 'FAILED'] }, runAt: { lt: overdueBefore } },
      orderBy: { runAt: 'asc' },
      select: { runAt: true },
    }),
    db.job.count({ where: { status: 'DEAD' } }),
    db.job.count({
      where: { status: 'RUNNING', leaseExpiresAt: { lt: now } },
    }),
  ]);

  const workers: WorkerStatus[] = rows.map((row) => {
    const secondsSinceSeen = Math.max(
      0,
      Math.round((now.getTime() - row.lastSeenAt.getTime()) / 1000),
    );
    return {
      name: row.name,
      pid: row.pid,
      startedAt: row.startedAt,
      lastSeenAt: row.lastSeenAt,
      ticks: row.ticks,
      lastError: row.lastError,
      secondsSinceSeen,
      stalled: row.lastSeenAt < staleBefore,
    };
  });

  const live = workers.filter((worker) => !worker.stalled);
  const noLiveWorker = live.length === 0;
  const oldestOverdueMinutes = oldestOverdue
    ? Math.round((now.getTime() - oldestOverdue.runAt.getTime()) / 60_000)
    : null;

  const warnings: HealthWarning[] = [];

  if (workers.length === 0) {
    warnings.push({
      severity: 'critical',
      title: 'No worker has ever reported in',
      detail:
        'Nothing has written a heartbeat. Invitations stay in DRAFT, screening links are never sent, and every scheduled sweep is silently not happening.',
      nextAction: 'Start the worker with `npm run worker` and reload this page.',
    });
  } else if (noLiveWorker) {
    const newest = workers[0]!;
    warnings.push({
      severity: 'critical',
      title: 'No worker is running',
      detail: `The last heartbeat was ${newest.secondsSinceSeen}s ago from "${newest.name}" (pid ${newest.pid}). Anything queued since then has not run.`,
      nextAction: 'Restart the worker, then check the overdue count below returns to zero.',
    });
  }

  for (const worker of workers) {
    if (!worker.stalled && worker.lastError) {
      warnings.push({
        severity: 'warning',
        title: `Worker "${worker.name}" is running but its last tick failed`,
        detail: worker.lastError,
        nextAction: 'Check the failed jobs below; the worker itself is still alive.',
      });
    }
  }

  if (overdue > 0) {
    warnings.push({
      severity: live.length > 0 ? 'warning' : 'critical',
      title: `${overdue} job${overdue === 1 ? '' : 's'} overdue`,
      detail:
        oldestOverdueMinutes === null
          ? 'Jobs are due and have not been claimed.'
          : `The oldest has been waiting ${oldestOverdueMinutes} minutes past its run time.`,
      nextAction: live.length
        ? 'A worker is running, so these are either failing repeatedly or backed up. Check the failed jobs below.'
        : 'Start a worker. These will be claimed on its first tick.',
    });
  }

  if (runningPastLease > 0) {
    warnings.push({
      severity: 'warning',
      title: `${runningPastLease} job${runningPastLease === 1 ? '' : 's'} past their lease`,
      detail:
        'These were claimed by a worker that stopped renewing. They are recovered automatically on the next sweep, bounded by their remaining attempts.',
      nextAction:
        'No action unless the count keeps growing, which means a worker is dying mid-job.',
    });
  }

  if (deadJobs > 0) {
    warnings.push({
      severity: 'warning',
      title: `${deadJobs} job${deadJobs === 1 ? '' : 's'} exhausted their retries`,
      detail:
        'These stopped retrying and will not run again on their own. Whatever each one was meant to do has not happened.',
      nextAction: 'Fix the cause, then retry each from the table below.',
    });
  }

  return {
    workers,
    noLiveWorker,
    overdueJobs: overdue,
    oldestOverdueMinutes,
    deadJobs,
    runningPastLease,
    warnings,
  };
}

/** Housekeeping: drop heartbeats for workers that are long gone. */
export async function pruneWorkerHeartbeats(db: Db, olderThan: Date): Promise<number> {
  const result = await db.workerHeartbeat.deleteMany({ where: { lastSeenAt: { lt: olderThan } } });
  return result.count;
}
