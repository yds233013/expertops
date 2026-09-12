import { type DedupeScope, type Job, type JobStatus, type Prisma } from '@prisma/client';
import { type Db, isPrismaErrorCode, PG_UNIQUE_VIOLATION } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { forbidden, notFound } from '@/lib/errors';
import { secondsFromNow } from '@/lib/time';

/**
 * PostgreSQL-backed job queue.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED` inside a single UPDATE ... FROM
 * statement, which is the standard way to let N workers share one table
 * without ever handing the same row to two of them. There is no external broker
 * and no in-memory state: restart the worker and it picks up where it left off.
 *
 * ## Ownership
 *
 * Two workers can still end up believing they own the same job, because a lease
 * has to expire eventually or a crashed worker would block a job forever. What
 * must never happen is that both of them *act* on it.
 *
 * Every claim mints a fresh `claimId`. That value is a fencing token: it is
 * required to renew the lease, to complete the job, and to fail it. A worker
 * whose lease expired and was taken over still holds the old `claimId`, so
 * every one of those operations matches zero rows and it is told it has lost
 * the job. The worker runs the handler and the completion inside one
 * transaction, so losing the claim at completion rolls the handler's writes
 * back rather than leaving a half-applied side effect behind.
 *
 * The lease is bounded and renewed while a handler runs, so a legitimately slow
 * handler does not get taken over in the first place. Renewal alone would not be
 * enough — a paused process renews nothing and notices nothing — which is why
 * the fencing check exists as well.
 */
export const JOB_TYPES = [
  // Invitations
  'invitation.send',
  'invitation.remind',
  'invitation.expire',
  // Onboarding
  'onboarding.start',
  'onboarding.nudge',
  // Applications and screening
  'application.acknowledge',
  'screening.invite',
  'screening.remind_candidate',
  'screening.expire',
  'screening.assign_reviewer',
  'review.remind',
  'review.escalate_overdue',
  // Qualification and readiness
  'qualification.apply',
  'readiness.recheck',
  // Staffing
  'staffing.detect_gaps',
  'staffing.project_start_tasks',
  'staffing.propose_replacements',
  'matching.run',
  // Delivery, support and payment
  'work.review_task',
  'work.remind_overdue',
  'support.check_response_sla',
  'payment.draft_from_approved_work',
  // Cross-cutting
  'attention.sweep',
  'project.offboarding_tasks',
  'outbox.dispatch',
  'maintenance.sweep',
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export interface EnqueueInput {
  type: JobType;
  payload?: Prisma.InputJsonValue;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  /** Unique key; a second enqueue with the same key is a no-op. */
  dedupeKey?: string | null;
  /**
   * Whether that key may be freed when this job's history is pruned.
   *
   * Omit it for anything that identifies a business event. The default is
   * DURABLE, so forgetting retains the key rather than deleting it: a freed key
   * silently re-arms an effect, and nothing notices until it happens twice.
   *
   * Pass DISPOSABLE only when the key provably cannot recur — a scheduler tick
   * bucket, or a one-shot keyed by the millisecond it was queued.
   */
  dedupeScope?: DedupeScope;
}

export interface EnqueueResult {
  job: Job | null;
  deduplicated: boolean;
}

export async function enqueueJob(db: Db, input: EnqueueInput): Promise<EnqueueResult> {
  try {
    const job = await db.job.create({
      data: {
        type: input.type,
        payload: input.payload ?? {},
        runAt: input.runAt ?? clockNow(),
        priority: input.priority ?? 100,
        maxAttempts: input.maxAttempts ?? 5,
        dedupeKey: input.dedupeKey ?? null,
        dedupeScope: input.dedupeScope ?? 'DURABLE',
        status: 'PENDING',
      },
    });
    return { job, deduplicated: false };
  } catch (error) {
    if (input.dedupeKey && isPrismaErrorCode(error, PG_UNIQUE_VIOLATION)) {
      const existing = await db.job.findUnique({ where: { dedupeKey: input.dedupeKey } });
      return { job: existing, deduplicated: true };
    }
    throw error;
  }
}

interface ClaimedRow {
  id: string;
  type: string;
  payload: Prisma.JsonValue;
  attempts: number;
  max_attempts: number;
  claim_id: string;
  lease_expires_at: Date;
}

export interface ClaimedJob {
  id: string;
  type: JobType;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  /** Fencing token for this claim. Required to renew, complete or fail. */
  claimId: string;
  leaseExpiresAt: Date;
}

/** Default lease length. Deliberately short relative to the renewal interval. */
export const DEFAULT_LEASE_SECONDS = 120;

/**
 * Atomically claim up to `limit` runnable jobs for `workerName`.
 *
 * A job is runnable when it is PENDING or FAILED and due, or when it is RUNNING
 * with an expired lease — the worker that held it crashed, was paused, or lost
 * its connection.
 *
 * Two conditions bound recovery. `attempts < maxAttempts` is checked here, so a
 * job whose worker is killed on every attempt stops being re-offered instead of
 * looping forever; `reapAbandonedJobs` then declares it dead. And the attempt
 * counter is incremented by the claim itself, so an abandoned attempt counts
 * exactly like a failed one.
 */
export async function claimJobs(
  db: Db,
  options: {
    workerName: string;
    limit: number;
    /** How long this claim is valid before another worker may take over. */
    leaseSeconds?: number;
    now?: Date;
  },
): Promise<ClaimedJob[]> {
  const now = options.now ?? clockNow();
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);

  const rows = await db.$queryRaw<ClaimedRow[]>`
    UPDATE "Job" AS j
    SET "status" = 'RUNNING',
        "lockedAt" = ${now},
        "lockedBy" = ${options.workerName},
        "claimId" = gen_random_uuid()::text,
        "leaseExpiresAt" = ${leaseExpiresAt},
        "startedAt" = COALESCE(j."startedAt", ${now}),
        "attempts" = j."attempts" + 1,
        "updatedAt" = ${now}
    FROM (
      SELECT "id"
      FROM "Job"
      WHERE "attempts" < "maxAttempts"
        AND (
              ("status" IN ('PENDING', 'FAILED') AND "runAt" <= ${now})
              OR (
                   "status" = 'RUNNING'
                   AND "leaseExpiresAt" IS NOT NULL
                   AND "leaseExpiresAt" < ${now}
                 )
            )
      ORDER BY "priority" ASC, "runAt" ASC, "createdAt" ASC
      LIMIT ${options.limit}
      FOR UPDATE SKIP LOCKED
    ) AS candidate
    WHERE j."id" = candidate."id"
    RETURNING j."id", j."type", j."payload", j."attempts", j."maxAttempts" AS max_attempts,
              j."claimId" AS claim_id, j."leaseExpiresAt" AS lease_expires_at
  `;

  return rows.map((row) => ({
    id: row.id,
    type: row.type as JobType,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    claimId: row.claim_id,
    leaseExpiresAt: row.lease_expires_at,
  }));
}

/**
 * Extend the lease on a job this worker still owns.
 *
 * Returns false when the claim is gone, which means another worker has taken
 * the job over and this one must stop. Callers use it both as a heartbeat
 * during a slow handler and once before starting work, because a job claimed in
 * a batch may sit behind several others and reach the front with very little
 * lease left.
 */
export async function renewLease(
  db: Db,
  jobId: string,
  claimId: string,
  options: { leaseSeconds?: number; now?: Date } = {},
): Promise<boolean> {
  const now = options.now ?? clockNow();
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const updated = await db.job.updateMany({
    where: { id: jobId, claimId, status: 'RUNNING' },
    data: { leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000) },
  });
  return updated.count === 1;
}

/** Thrown when a worker discovers mid-flight that its claim is no longer valid. */
export class LostClaimError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super(`Job ${jobId} is no longer owned by this worker; its lease was taken over.`);
    this.name = 'LostClaimError';
    this.jobId = jobId;
  }
}

/**
 * Mark a job succeeded, but only if this worker still owns it.
 *
 * Returns false when the claim has been taken over. Callers run this inside the
 * same transaction as the handler's writes, so a false result can be turned
 * into a rollback: the stale worker's business effects disappear along with its
 * claim to have done the work.
 */
export async function completeJob(
  db: Db,
  jobId: string,
  claimId: string,
  result: Prisma.InputJsonValue,
): Promise<boolean> {
  const updated = await db.job.updateMany({
    where: { id: jobId, claimId, status: 'RUNNING' },
    data: {
      status: 'SUCCEEDED',
      finishedAt: clockNow(),
      lockedAt: null,
      lockedBy: null,
      claimId: null,
      leaseExpiresAt: null,
      lastError: null,
      result,
    },
  });
  return updated.count === 1;
}

/** Exponential backoff with a cap, so a broken handler does not hot-loop. */
export function backoffSeconds(attempts: number): number {
  return Math.min(2 ** Math.max(attempts - 1, 0) * 5, 600);
}

/**
 * Record a failure, but only if this worker still owns the job.
 *
 * Returns null when the claim has been taken over: a worker that lost its lease
 * must not reset the attempt schedule, overwrite the error, or push a job the
 * new owner is currently running back into the queue.
 */
export async function failJob(
  db: Db,
  jobId: string,
  claimId: string,
  error: string,
  options: { attempts: number; maxAttempts: number; now?: Date },
): Promise<JobStatus | null> {
  const now = options.now ?? clockNow();
  const exhausted = options.attempts >= options.maxAttempts;
  const status: JobStatus = exhausted ? 'DEAD' : 'FAILED';
  const updated = await db.job.updateMany({
    where: { id: jobId, claimId },
    data: {
      status,
      lastError: error.slice(0, 2000),
      lockedAt: null,
      lockedBy: null,
      claimId: null,
      leaseExpiresAt: null,
      finishedAt: exhausted ? now : null,
      runAt: exhausted ? now : secondsFromNow(backoffSeconds(options.attempts), now),
    },
  });
  return updated.count === 1 ? status : null;
}

export interface ReapResult {
  /** Abandoned claims that still had attempts left and were released to retry. */
  released: number;
  /** Abandoned claims with no attempts left, declared dead. */
  died: number;
}

/**
 * Deal with claims whose worker never came back.
 *
 * Claiming already recovers an expired lease while attempts remain. This closes
 * the other end: a job whose worker is killed on every single attempt would
 * otherwise sit RUNNING forever, invisible to both the claim query (attempts
 * exhausted) and to `failJob` (nobody is left to call it). Recovery is bounded
 * by the same `maxAttempts` as ordinary failure.
 */
export async function reapAbandonedJobs(
  db: Db,
  options: { now?: Date; graceSeconds?: number } = {},
): Promise<ReapResult> {
  const now = options.now ?? clockNow();
  // A small grace period keeps this from racing a lease renewal that is in
  // flight at the moment the sweep runs.
  const cutoff = new Date(now.getTime() - (options.graceSeconds ?? 30) * 1000);

  const abandoned = await db.job.findMany({
    where: { status: 'RUNNING', leaseExpiresAt: { lt: cutoff } },
    select: { id: true, attempts: true, maxAttempts: true, lockedBy: true },
    take: 200,
  });

  let released = 0;
  let died = 0;
  for (const job of abandoned) {
    const exhausted = job.attempts >= job.maxAttempts;
    const claimed = await db.job.updateMany({
      // Re-checking status and expiry makes two sweeps racing each other safe.
      where: { id: job.id, status: 'RUNNING', leaseExpiresAt: { lt: cutoff } },
      data: exhausted
        ? {
            status: 'DEAD',
            finishedAt: now,
            lockedAt: null,
            lockedBy: null,
            claimId: null,
            leaseExpiresAt: null,
            lastError: `Abandoned by ${job.lockedBy ?? 'a worker'} after ${job.attempts} attempt(s); no attempts remain.`,
          }
        : {
            status: 'FAILED',
            lockedAt: null,
            lockedBy: null,
            claimId: null,
            leaseExpiresAt: null,
            runAt: secondsFromNow(backoffSeconds(job.attempts), now),
            lastError: `Abandoned by ${job.lockedBy ?? 'a worker'}; lease expired without a result.`,
          },
    });
    if (claimed.count === 0) continue;
    if (exhausted) died += 1;
    else released += 1;
  }

  return { released, died };
}

export interface JobQuery {
  status?: JobStatus;
  type?: string;
  limit?: number;
  cursor?: string;
}

export async function listJobs(db: Db, query: JobQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const where: Prisma.JobWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.type) where.type = query.type;

  const rows = await db.job.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  return {
    jobs: hasMore ? rows.slice(0, limit) : rows,
    nextCursor: hasMore ? (rows[limit - 1]?.id ?? null) : null,
  };
}

export async function jobCounts(db: Db): Promise<Record<JobStatus, number>> {
  const grouped = await db.job.groupBy({ by: ['status'], _count: { _all: true } });
  const counts: Record<JobStatus, number> = {
    PENDING: 0,
    RUNNING: 0,
    SUCCEEDED: 0,
    FAILED: 0,
    DEAD: 0,
    CANCELLED: 0,
  };
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
}

/** Put a DEAD or FAILED job back in the queue. Requires the `jobs:manage` capability. */
export async function retryJob(db: Db, jobId: string): Promise<Job> {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) throw notFound('Job not found.');
  if (job.status !== 'DEAD' && job.status !== 'FAILED' && job.status !== 'CANCELLED') {
    throw forbidden(
      `Only DEAD, FAILED or CANCELLED jobs can be retried (this one is ${job.status}).`,
    );
  }
  return db.job.update({
    where: { id: jobId },
    data: {
      status: 'PENDING',
      runAt: clockNow(),
      attempts: 0,
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      claimId: null,
      leaseExpiresAt: null,
      finishedAt: null,
      startedAt: null,
    },
  });
}

export async function cancelJob(db: Db, jobId: string): Promise<Job> {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) throw notFound('Job not found.');
  if (job.status === 'SUCCEEDED') throw forbidden('A succeeded job cannot be cancelled.');
  return db.job.update({
    where: { id: jobId },
    data: {
      status: 'CANCELLED',
      lockedAt: null,
      lockedBy: null,
      claimId: null,
      leaseExpiresAt: null,
      finishedAt: clockNow(),
    },
  });
}

/**
 * Housekeeping: drop old terminal jobs so the table does not grow forever.
 *
 * Deleting a job row frees its `dedupeKey`, and for a key that identifies a
 * business event that is not housekeeping — it re-arms the effect. A pruned
 * `onboarding.start:<invitationId>` means the same invitation can enqueue that
 * job again, and the handler issues a fresh portal token and queues another
 * onboarding email every time it runs.
 *
 * So pruning is restricted to rows that hold nothing worth keeping: those with
 * no key at all, and those a caller explicitly marked DISPOSABLE. Scope is
 * never inferred from the shape of the key; a caller has to say so.
 *
 * Failures and dead letters are never pruned by age either, because a failure
 * is evidence.
 */
export async function pruneFinishedJobs(db: Db, olderThan: Date): Promise<number> {
  const result = await db.job.deleteMany({
    where: {
      status: { in: ['SUCCEEDED', 'CANCELLED'] },
      finishedAt: { lt: olderThan },
      OR: [{ dedupeKey: null }, { dedupeScope: 'DISPOSABLE' }],
    },
  });
  return result.count;
}

/**
 * How much history is being retained, and why.
 *
 * Surfaced on the Worker screen so the growth this policy accepts is visible
 * rather than something an operator discovers from disk usage.
 */
export async function retentionSummary(db: Db) {
  const [prunable, retainedForDedupe, failures] = await Promise.all([
    db.job.count({
      where: {
        status: { in: ['SUCCEEDED', 'CANCELLED'] },
        OR: [{ dedupeKey: null }, { dedupeScope: 'DISPOSABLE' }],
      },
    }),
    db.job.count({
      where: {
        status: { in: ['SUCCEEDED', 'CANCELLED'] },
        dedupeKey: { not: null },
        dedupeScope: 'DURABLE',
      },
    }),
    db.job.count({ where: { status: { in: ['FAILED', 'DEAD'] } } }),
  ]);
  return { prunable, retainedForDedupe, failures };
}
