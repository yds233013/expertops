import { randomUUID } from 'node:crypto';
import { type Prisma } from '@prisma/client';
import { type Transactor } from '@/lib/db';
import { errorMessage } from '@/lib/errors';
import { createLogger, type Logger } from '@/lib/logger';
import { claimJobs, completeJob, failJob } from '@/server/services/jobs';
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
  lockTimeoutSeconds?: number;
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
}

const EMPTY_TICK: TickSummary = {
  schedulesFired: 0,
  jobsClaimed: 0,
  jobsSucceeded: 0,
  jobsFailed: 0,
  jobsDead: 0,
  unknownTypes: 0,
};

export class Worker {
  private readonly client: Transactor;
  private readonly name: string;
  private readonly batchSize: number;
  private readonly lockTimeoutSeconds: number;
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
    this.lockTimeoutSeconds = options.lockTimeoutSeconds ?? 120;
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
      lockTimeoutSeconds: this.lockTimeoutSeconds,
      now,
    });
    summary.jobsClaimed = claimed.length;

    for (const job of claimed) {
      const handler = handlerFor(job.type);
      if (!handler) {
        summary.unknownTypes += 1;
        const status = await failJob(
          this.client,
          job.id,
          `No handler registered for "${job.type}"`,
          {
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
            now,
          },
        );
        if (status === 'DEAD') summary.jobsDead += 1;
        else summary.jobsFailed += 1;
        this.log.error('unknown job type', { jobId: job.id, type: job.type });
        continue;
      }

      const ctx: HandlerContext = { db: this.client, client: this.client, now };
      const startedAt = Date.now();
      try {
        const result = await handler(job.payload, ctx);
        await completeJob(this.client, job.id, result as Prisma.InputJsonValue);
        summary.jobsSucceeded += 1;
        this.log.info('job succeeded', {
          jobId: job.id,
          type: job.type,
          attempt: job.attempts,
          ms: Date.now() - startedAt,
        });
      } catch (error) {
        const message = errorMessage(error);
        const status = await failJob(this.client, job.id, message, {
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          now,
        });
        if (status === 'DEAD') {
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
      }
    }

    return summary;
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
      lockTimeoutSeconds: this.lockTimeoutSeconds,
    });

    while (!this.stopRequested) {
      try {
        const summary = await this.tick();
        // Only sleep when the queue was empty; a full batch means more work.
        if (summary.jobsClaimed === 0) {
          await this.sleep(this.pollIntervalMs);
        }
      } catch (error) {
        this.log.error('tick failed', { error: errorMessage(error) });
        await this.sleep(Math.max(this.pollIntervalMs, 2000));
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
