import { Prisma, type Schedule } from '@prisma/client';
import { type Db, type Transactor } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
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
  {
    name: 'attention-sweep',
    jobType: 'attention.sweep',
    intervalSeconds: 120,
    description:
      'Recomputes the Needs-attention queue: staffing gaps, duplicates, conflicts, re-reviews and pending approvals.',
  },
  {
    name: 'staffing-gap-detection',
    jobType: 'staffing.detect_gaps',
    intervalSeconds: 300,
    description: 'Finds projects that will not be staffed in time.',
  },
  {
    name: 'screening-expire',
    jobType: 'screening.expire',
    intervalSeconds: 300,
    description: 'Closes screenings whose submission window has passed.',
  },
  {
    name: 'screening-remind',
    jobType: 'screening.remind_candidate',
    intervalSeconds: 600,
    description: 'Reminds candidates with an open screening, subject to the reminder cap.',
  },
  {
    name: 'review-remind',
    jobType: 'review.remind',
    intervalSeconds: 600,
    description: 'Chases reviewers past their deadline, at most twice.',
  },
  {
    name: 'review-escalate',
    jobType: 'review.escalate_overdue',
    intervalSeconds: 600,
    description: 'Escalates overdue reviews to the operator attention queue.',
  },
  {
    name: 'work-overdue',
    jobType: 'work.remind_overdue',
    intervalSeconds: 900,
    description: 'Flags work items past their due date.',
  },
  {
    name: 'support-sla',
    jobType: 'support.check_response_sla',
    intervalSeconds: 600,
    description: 'Flags support requests that have had no reply within their response target.',
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
        nextRunAt: clockNow(),
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
 * Claim one due schedule, advancing `nextRunAt` in the same statement.
 *
 * `nextRunAt` is set from `now` rather than from the previous `nextRunAt`, so a
 * worker that was offline for an hour fires each schedule once on restart
 * instead of replaying a backlog of ticks.
 *
 * One at a time, rather than the whole batch, because claiming and enqueuing
 * have to share a transaction: a schedule is only allowed to move forward if
 * the job it exists to create was actually created.
 */
async function claimOneDueSchedule(
  db: Db,
  options: { now: Date; skipIds: string[] },
): Promise<DueSchedule | null> {
  const { now, skipIds } = options;
  const exclusion = skipIds.length > 0 ? Prisma.sql`AND "id" <> ALL(${skipIds})` : Prisma.empty;

  const rows = await db.$queryRaw<DueScheduleRow[]>`
    UPDATE "Schedule" AS s
    SET "lastRunAt" = ${now},
        "nextRunAt" = ${now} + make_interval(secs => s."intervalSeconds"),
        "updatedAt" = ${now}
    FROM (
      SELECT "id"
      FROM "Schedule"
      WHERE "enabled" = true AND "nextRunAt" <= ${now}
      ${exclusion}
      ORDER BY "nextRunAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    ) AS candidate
    WHERE s."id" = candidate."id"
    RETURNING s."id", s."name", s."jobType" AS job_type, s."payload", s."intervalSeconds" AS interval_seconds
  `;

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    jobType: row.job_type as JobType,
    payload: row.payload,
  };
}

export interface DueSchedule {
  id: string;
  name: string;
  jobType: JobType;
  payload: unknown;
}

export interface TickResult {
  claimed: number;
  enqueued: number;
  deduplicated: number;
  /** Schedules whose enqueue failed; their due time was rolled back, not consumed. */
  failed: Array<{ name: string; error: string }>;
  scheduleNames: string[];
}

/**
 * One scheduler tick: claim due schedules and enqueue their jobs.
 *
 * Claiming a schedule and creating its job are one transaction. Previously they
 * were two statements: a schedule advanced its `nextRunAt` first, and if the
 * enqueue then failed, that execution was silently consumed — the job never
 * existed and the schedule would not be due again until the next interval.
 * Rolling back together means a failed enqueue leaves the schedule due, so the
 * next tick retries it.
 *
 * The dedupe key is derived from the schedule name and its tick bucket, so even
 * if two workers somehow claimed the same schedule only one job row is created.
 */
export async function tickSchedules(
  client: Transactor,
  options: { now?: Date; limit?: number } = {},
): Promise<TickResult> {
  const now = options.now ?? clockNow();
  const limit = options.limit ?? 25;

  let claimed = 0;
  let enqueued = 0;
  let deduplicated = 0;
  const failed: TickResult['failed'] = [];
  const scheduleNames: string[] = [];
  // Schedules already handled this tick, so a rolled-back one is not retried
  // in a loop within the same tick.
  const handled: string[] = [];

  for (let index = 0; index < limit; index += 1) {
    let name: string | null = null;
    try {
      const done = await client.$transaction(async (tx) => {
        const schedule = await claimOneDueSchedule(tx, { now, skipIds: handled });
        if (!schedule) return false;
        name = schedule.name;
        handled.push(schedule.id);

        const bucket = Math.floor(now.getTime() / 1000);
        const result = await enqueueJob(tx, {
          type: schedule.jobType,
          payload: (schedule.payload as Prisma.InputJsonValue) ?? {},
          priority: 50,
          dedupeKey: `schedule:${schedule.name}:${bucket}`,
          // A tick bucket cannot recur, so this key is safe to free with its
          // history. Scheduler rows are the bulk of the table.
          dedupeScope: 'DISPOSABLE',
        });
        if (result.deduplicated) deduplicated += 1;
        else enqueued += 1;
        if (result.job) {
          await tx.schedule.update({
            where: { id: schedule.id },
            data: { lastJobId: result.job.id },
          });
        }
        return true;
      });

      if (!done) break;
      claimed += 1;
      if (name) scheduleNames.push(name);
    } catch (error) {
      // The transaction rolled back, so this schedule is still due. Record it
      // and move on rather than letting one broken schedule stall the rest.
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ name: name ?? 'unknown', error: message });
      // `handled` was rolled back with the transaction; re-exclude it here so
      // the loop makes progress.
      if (name) {
        const row = await client.schedule.findUnique({ where: { name } }).catch(() => null);
        if (row) handled.push(row.id);
      }
    }
  }

  return { claimed, enqueued, deduplicated, failed, scheduleNames };
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
