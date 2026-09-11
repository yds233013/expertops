import { type Prisma, type Schedule } from '@prisma/client';
import { type Db } from '@/lib/db';
import { secondsFromNow } from '@/lib/time';
import { enqueueJob, type JobType } from './jobs';

/**
 * Scheduled jobs.
 *
 * A schedule is a row with an interval and a `nextRunAt`. The worker claims due
 * schedules with `FOR UPDATE SKIP LOCKED` and advances `nextRunAt` in the same
 * statement, so running several workers does not double-fire a schedule.
 */
export interface ScheduleDefinition {
  name: string;
  jobType: JobType;
  intervalSeconds: number;
  payload?: Prisma.InputJsonValue;
  enabled?: boolean;
  description: string;
}

export const DEFAULT_SCHEDULES: readonly ScheduleDefinition[] = [
  {
    name: 'outbox-dispatch',
    jobType: 'outbox.dispatch',
    intervalSeconds: 15,
    description: 'Marks queued simulated emails as delivered.',
  },
  {
    name: 'invitation-expire',
    jobType: 'invitation.expire',
    intervalSeconds: 60,
    description: 'Closes invitations whose response deadline has passed.',
  },
  {
    name: 'invitation-remind',
    jobType: 'invitation.remind',
    intervalSeconds: 300,
    payload: { remindAfterHours: 24, minHoursRemaining: 2 },
    description: 'Sends a single reminder for invitations still open after 24 hours.',
  },
  {
    name: 'onboarding-nudge',
    jobType: 'onboarding.nudge',
    intervalSeconds: 600,
    payload: { nudgeAfterHours: 24 },
    description: 'Nudges experts whose onboarding checklist is stalled.',
  },
  {
    name: 'maintenance-sweep',
    jobType: 'maintenance.sweep',
    intervalSeconds: 3600,
    payload: { pruneJobsOlderThanDays: 7 },
    description: 'Purges expired sessions and old finished jobs.',
  },
] as const;

export async function ensureDefaultSchedules(db: Db): Promise<Schedule[]> {
  const results: Schedule[] = [];
  for (const definition of DEFAULT_SCHEDULES) {
    const schedule = await db.schedule.upsert({
      where: { name: definition.name },
      // Interval + payload are code-owned; enabled/nextRunAt stay operator-owned.
      update: {
        jobType: definition.jobType,
        intervalSeconds: definition.intervalSeconds,
        payload: definition.payload ?? {},
      },
      create: {
        name: definition.name,
        jobType: definition.jobType,
        intervalSeconds: definition.intervalSeconds,
        payload: definition.payload ?? {},
        enabled: definition.enabled ?? true,
        nextRunAt: new Date(),
      },
    });
    results.push(schedule);
  }
  return results;
}

interface DueScheduleRow {
  id: string;
  name: string;
  job_type: string;
  payload: Prisma.JsonValue;
  interval_seconds: number;
}

/**
 * Claim every schedule that is due, advancing `nextRunAt` atomically.
 *
 * `nextRunAt` is set from `now` rather than from the previous `nextRunAt`, so a
 * worker that was offline for an hour fires each schedule once on restart
 * instead of replaying a backlog of ticks.
 */
export async function claimDueSchedules(
  db: Db,
  options: { now?: Date; limit?: number } = {},
): Promise<Array<{ id: string; name: string; jobType: JobType; payload: unknown }>> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 25;

  const rows = await db.$queryRaw<DueScheduleRow[]>`
    UPDATE "Schedule" AS s
    SET "lastRunAt" = ${now},
        "nextRunAt" = ${now} + make_interval(secs => s."intervalSeconds"),
        "updatedAt" = ${now}
    FROM (
      SELECT "id"
      FROM "Schedule"
      WHERE "enabled" = true AND "nextRunAt" <= ${now}
      ORDER BY "nextRunAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ) AS candidate
    WHERE s."id" = candidate."id"
    RETURNING s."id", s."name", s."jobType" AS job_type, s."payload", s."intervalSeconds" AS interval_seconds
  `;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    jobType: row.job_type as JobType,
    payload: row.payload,
  }));
}

export interface TickResult {
  claimed: number;
  enqueued: number;
  deduplicated: number;
  scheduleNames: string[];
}

/**
 * One scheduler tick: claim due schedules and enqueue their jobs.
 *
 * The dedupe key is derived from the schedule name and its tick bucket, so even
 * if two workers somehow claimed the same schedule only one job row is created.
 */
export async function tickSchedules(db: Db, options: { now?: Date } = {}): Promise<TickResult> {
  const now = options.now ?? new Date();
  const due = await claimDueSchedules(db, { now });

  let enqueued = 0;
  let deduplicated = 0;
  for (const schedule of due) {
    const bucket = Math.floor(now.getTime() / 1000);
    const result = await enqueueJob(db, {
      type: schedule.jobType,
      payload: (schedule.payload as Prisma.InputJsonValue) ?? {},
      priority: 50,
      dedupeKey: `schedule:${schedule.name}:${bucket}`,
    });
    if (result.deduplicated) deduplicated += 1;
    else enqueued += 1;
    if (result.job) {
      await db.schedule.update({ where: { id: schedule.id }, data: { lastJobId: result.job.id } });
    }
  }

  return {
    claimed: due.length,
    enqueued,
    deduplicated,
    scheduleNames: due.map((s) => s.name),
  };
}

export async function listSchedules(db: Db) {
  return db.schedule.findMany({ orderBy: { name: 'asc' } });
}

export async function setScheduleEnabled(db: Db, name: string, enabled: boolean) {
  return db.schedule.update({
    where: { name },
    data: { enabled, ...(enabled ? { nextRunAt: secondsFromNow(1) } : {}) },
  });
}

export function scheduleDescription(name: string): string {
  return DEFAULT_SCHEDULES.find((s) => s.name === name)?.description ?? '';
}
