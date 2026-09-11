import { type Job, type JobStatus, type Prisma } from '@prisma/client';
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
}

/**
 * Atomically claim up to `limit` runnable jobs for `workerName`.
 *
 * A job is runnable when it is PENDING/FAILED and due, or when it is RUNNING
 * but its lock is older than `lockTimeoutSeconds` (the worker that held it
 * crashed).
 */
export async function claimJobs(
  db: Db,
  options: { workerName: string; limit: number; lockTimeoutSeconds: number; now?: Date },
): Promise<
  Array<{ id: string; type: JobType; payload: unknown; attempts: number; maxAttempts: number }>
> {
  const now = options.now ?? clockNow();
  const staleBefore = new Date(now.getTime() - options.lockTimeoutSeconds * 1000);

  const rows = await db.$queryRaw<ClaimedRow[]>`
    UPDATE "Job" AS j
    SET "status" = 'RUNNING',
        "lockedAt" = ${now},
        "lockedBy" = ${options.workerName},
        "startedAt" = COALESCE(j."startedAt", ${now}),
        "attempts" = j."attempts" + 1,
        "updatedAt" = ${now}
    FROM (
      SELECT "id"
      FROM "Job"
      WHERE (
              ("status" IN ('PENDING', 'FAILED') AND "runAt" <= ${now})
              OR ("status" = 'RUNNING' AND "lockedAt" IS NOT NULL AND "lockedAt" < ${staleBefore})
            )
      ORDER BY "priority" ASC, "runAt" ASC, "createdAt" ASC
      LIMIT ${options.limit}
      FOR UPDATE SKIP LOCKED
    ) AS candidate
    WHERE j."id" = candidate."id"
    RETURNING j."id", j."type", j."payload", j."attempts", j."maxAttempts" AS max_attempts
  `;

  return rows.map((row) => ({
    id: row.id,
    type: row.type as JobType,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  }));
}

export async function completeJob(
  db: Db,
  jobId: string,
  result: Prisma.InputJsonValue,
): Promise<void> {
  await db.job.update({
    where: { id: jobId },
    data: {
      status: 'SUCCEEDED',
      finishedAt: clockNow(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      result,
    },
  });
}

/** Exponential backoff with a cap, so a broken handler does not hot-loop. */
export function backoffSeconds(attempts: number): number {
  return Math.min(2 ** Math.max(attempts - 1, 0) * 5, 600);
}

export async function failJob(
  db: Db,
  jobId: string,
  error: string,
  options: { attempts: number; maxAttempts: number; now?: Date },
): Promise<JobStatus> {
  const now = options.now ?? clockNow();
  const exhausted = options.attempts >= options.maxAttempts;
  const status: JobStatus = exhausted ? 'DEAD' : 'FAILED';
  await db.job.update({
    where: { id: jobId },
    data: {
      status,
      lastError: error.slice(0, 2000),
      lockedAt: null,
      lockedBy: null,
      finishedAt: exhausted ? now : null,
      runAt: exhausted ? now : secondsFromNow(backoffSeconds(options.attempts), now),
    },
  });
  return status;
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
    data: { status: 'CANCELLED', lockedAt: null, lockedBy: null, finishedAt: clockNow() },
  });
}

/** Housekeeping: drop old terminal jobs so the table does not grow forever. */
export async function pruneFinishedJobs(db: Db, olderThan: Date): Promise<number> {
  const result = await db.job.deleteMany({
    where: { status: { in: ['SUCCEEDED', 'CANCELLED'] }, finishedAt: { lt: olderThan } },
  });
  return result.count;
}
