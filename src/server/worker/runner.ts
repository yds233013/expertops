import { randomUUID } from 'node:crypto';
import { type Prisma } from '@prisma/client';
import { type Transactor } from '@/lib/db';
import { errorMessage } from '@/lib/errors';
import { createLogger, type Logger } from '@/lib/logger';
import {
  claimJobs,
  completeJob,
  DEFAULT_LEASE_SECONDS,
  failJob,
  LostClaimError,
  reapAbandonedJobs,
  renewLease,
  type ClaimedJob,
} from '@/server/services/jobs';
import { ensureDefaultSchedules, tickSchedules } from '@/server/services/schedules';
import { handlerFor, type HandlerContext } from './handlers';

/**
 * The worker loop.
 *
 * One tick = advance the scheduler, claim a batch of jobs, run them. Everything
 * that matters (what is due, what is claimed, how many attempts remain) lives in
 * PostgreSQL, so the worker holds no state of its own and can be killed and
 * restarted at any point without losing or duplicating work.
 */
export interface WorkerOptions {
  client: Transactor;
  name?: string;
  batchSize?: number;
  /**
   * How long a claim stays valid without renewal. Named `leaseSeconds`; the
   * older `lockTimeoutSeconds` is accepted as an alias so existing
   * configuration keeps working.
   */
  leaseSeconds?: number;
  lockTimeoutSeconds?: number;
  /** How often a running job renews its lease. Defaults to a third of the lease. */
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  logger?: Logger;
}

export interface TickSummary {
  schedulesFired: number;
  jobsClaimed: number;
  jobsSucceeded: number;
  jobsFailed: number;
  jobsDead: number;
  unknownTypes: number;
  /** Jobs this worker held but lost to a lease takeover before finishing. */
  jobsLost: number;
  /** Abandoned claims released back to the queue by this tick's sweep. */
  jobsReleased: number;
}

const EMPTY_TICK: TickSummary = {
  schedulesFired: 0,
  jobsClaimed: 0,
  jobsSucceeded: 0,
  jobsFailed: 0,
  jobsDead: 0,
  unknownTypes: 0,
  jobsLost: 0,
  jobsReleased: 0,
};

export class Worker {
  private readonly client: Transactor;
  private readonly name: string;
  private readonly batchSize: number;
  private readonly leaseSeconds: number;
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly log: Logger;
  private running = false;
  private stopRequested = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;

  constructor(options: WorkerOptions) {
    this.client = options.client;
    this.name = options.name ?? `worker-${randomUUID().slice(0, 8)}`;
    this.batchSize = options.batchSize ?? 5;
    this.leaseSeconds = options.leaseSeconds ?? options.lockTimeoutSeconds ?? DEFAULT_LEASE_SECONDS;
    // Renew comfortably inside the lease so one slow renewal is not fatal.
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? Math.max(250, Math.floor((this.leaseSeconds * 1000) / 3));
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.log = options.logger ?? createLogger(`worker:${this.name}`);
  }

  get workerName(): string {
    return this.name;
  }

  /** Idempotent: creates any schedule rows the build expects. */
  async bootstrap(): Promise<void> {
    const schedules = await ensureDefaultSchedules(this.client);
    this.log.info('schedules ready', { count: schedules.length });
  }

  /** Run exactly one tick. This is what the tests drive. */
  async tick(now: Date = new Date()): Promise<TickSummary> {
    const summary: TickSummary = { ...EMPTY_TICK };

    const scheduleResult = await tickSchedules(this.client, { now });
    summary.schedulesFired = scheduleResult.enqueued;
    if (scheduleResult.enqueued > 0) {
      this.log.debug('schedules fired', { names: scheduleResult.scheduleNames });
    }

    const claimed = await claimJobs(this.client, {
      workerName: this.name,
      limit: this.batchSize,
      leaseSeconds: this.leaseSeconds,
      now,
    });
    summary.jobsClaimed = claimed.length;

    for (const job of claimed) {
      await this.runClaimedJob(job, summary, now);
    }

    // Close the loop on claims nobody is coming back for. Done after the batch
    // so this worker never reaps a job it is about to run itself.
    const reaped = await reapAbandonedJobs(this.client, { now });
    summary.jobsReleased = reaped.released;
    summary.jobsDead += reaped.died;
    if (reaped.released || reaped.died) {
      this.log.warn('recovered abandoned claims', { ...reaped });
    }

    return summary;
  }

  /**
   * Run one claimed job under its lease.
   *
   * Three protections, and each covers a case the others do not:
   *
   *  * **A renewal before starting.** A batch is claimed in one statement but
   *    executed one job at a time, so the last job in a batch can reach the
   *    front with most of its lease already spent. Renewing here also detects a
   *    job that was taken over while it waited, and skips it without running the
   *    handler at all.
   *  * **A heartbeat while the handler runs.** Renewal happens on a connection
   *    of its own, outside the execution transaction, so a legitimately slow
   *    handler keeps its lease and is never taken over in the first place.
   *  * **A fencing check at completion, inside the transaction.** If the claim
   *    was taken over anyway — a paused process renews nothing and notices
   *    nothing — completion matches no row, the transaction throws, and every
   *    write the handler made is rolled back with it.
   */
  private async runClaimedJob(job: ClaimedJob, summary: TickSummary, now: Date): Promise<void> {
    const handler = handlerFor(job.type);
    if (!handler) {
      summary.unknownTypes += 1;
      const status = await failJob(
        this.client,
        job.id,
        job.claimId,
        `No handler registered for "${job.type}"`,
        { attempts: job.attempts, maxAttempts: job.maxAttempts, now },
      );
      if (status === 'DEAD') summary.jobsDead += 1;
      else if (status === 'FAILED') summary.jobsFailed += 1;
      else summary.jobsLost += 1;
      this.log.error('unknown job type', { jobId: job.id, type: job.type });
      return;
    }

    const stillOwned = await renewLease(this.client, job.id, job.claimId, {
      leaseSeconds: this.leaseSeconds,
    });
    if (!stillOwned) {
      summary.jobsLost += 1;
      this.log.warn('claim lost before start, not running', { jobId: job.id, type: job.type });
      return;
    }

    const heartbeat = setInterval(() => {
      void renewLease(this.client, job.id, job.claimId, {
        leaseSeconds: this.leaseSeconds,
      }).catch(() => undefined);
    }, this.heartbeatIntervalMs);
    heartbeat.unref?.();

    const startedAt = Date.now();
    try {
      await this.client.$transaction(
        async (tx) => {
          const ctx: HandlerContext = { db: tx, client: tx, now };
          const result = await handler(job.payload, ctx);
          const owned = await completeJob(tx, job.id, job.claimId, result as Prisma.InputJsonValue);
          // Throwing is the point: it rolls the handler's writes back.
          if (!owned) throw new LostClaimError(job.id);
        },
        {
          // A handler may legitimately run for most of its lease.
          timeout: this.leaseSeconds * 1000,
          maxWait: 10_000,
        },
      );
      summary.jobsSucceeded += 1;
      this.log.info('job succeeded', {
        jobId: job.id,
        type: job.type,
        attempt: job.attempts,
        ms: Date.now() - startedAt,
      });
    } catch (error) {
      if (error instanceof LostClaimError) {
        summary.jobsLost += 1;
        this.log.warn('claim lost during execution; work rolled back', {
          jobId: job.id,
          type: job.type,
          attempt: job.attempts,
        });
        return;
      }

      const message = errorMessage(error);
      const status = await failJob(this.client, job.id, job.claimId, message, {
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        now,
      });
      if (status === null) {
        summary.jobsLost += 1;
        this.log.warn('job failed but the claim was already gone; leaving it alone', {
          jobId: job.id,
          type: job.type,
          error: message,
        });
      } else if (status === 'DEAD') {
        summary.jobsDead += 1;
        this.log.error('job dead after retries', {
          jobId: job.id,
          type: job.type,
          attempts: job.attempts,
          error: message,
        });
      } else {
        summary.jobsFailed += 1;
        this.log.warn('job failed, will retry', {
          jobId: job.id,
          type: job.type,
          attempt: job.attempts,
          error: message,
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Long-running loop. Returns when `stop()` is called. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    await this.bootstrap();
    this.log.info('worker started', {
      batchSize: this.batchSize,
      pollIntervalMs: this.pollIntervalMs,
      leaseSeconds: this.leaseSeconds,
    });

    while (!this.stopRequested) {
      try {
        const summary = await this.tick();
        // Only sleep when the queue was empty; a full batch means more work.
        // The stop flag is re-checked first: `stop()` called *during* a tick
        // used to be followed by a full poll interval of sleeping, because the
        // loop only looked at the flag on its way back round.
        if (summary.jobsClaimed === 0 && !this.stopRequested) {
          await this.sleep(this.pollIntervalMs);
        }
      } catch (error) {
        this.log.error('tick failed', { error: errorMessage(error) });
        if (!this.stopRequested) await this.sleep(Math.max(this.pollIntervalMs, 2000));
      }
    }

    this.running = false;
    this.log.info('worker stopped');
  }

  stop(): void {
    this.stopRequested = true;
    if (this.idleTimer) {
      // Fire the pending sleep immediately so the loop notices the stop flag
      // instead of waiting out the remaining poll interval.
      const timer = this.idleTimer;
      this.idleTimer = null;
      clearTimeout(timer);
      this.wake?.();
    }
  }

  /**
   * The poll timer is deliberately NOT unref'd: it is the only thing keeping
   * the event loop alive between ticks, and unref'ing it makes the worker
   * process exit silently after its first idle tick. Shutdown goes through
   * `stop()`, which clears the timer.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.wake = null;
        resolve();
      }, ms);
    });
  }
}
