import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { applyMigrations, newClient, truncateAll } from '../helpers/db';
import { claimJobs, enqueueJob, reapAbandonedJobs } from '@/server/services/jobs';
import { Worker } from '@/server/worker/runner';
import { registerTestHandler, unregisterTestHandler } from '@/server/worker/handlers';
import { workerHealth } from '@/server/services/worker-health';

/**
 * What happens when something is pulled out mid-flight.
 *
 * Two interruptions, both simulated inside an isolated database rather than by
 * stopping a shared service: a worker killed while a job is half done, and the
 * database connection dropped underneath one. The question each time is the
 * same — does the work survive, and does it happen exactly once.
 *
 * These use a dedicated connection per worker so a connection can be destroyed
 * without taking the test's own client with it.
 */
const clients: PrismaClient[] = [];
function client(): PrismaClient {
  const created = newClient();
  clients.push(created);
  return created;
}

describe('interruption and recovery', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.$disconnect().catch(() => undefined)));
  });

  it('a worker whose connection dies mid-job loses the partial work and repeats nothing', async () => {
    // A kill, as PostgreSQL sees one: the backend running the job's transaction
    // goes away with the transaction still open. Terminating the backend from
    // inside is the deterministic way to produce that; waiting on a killed
    // process would make the test depend on timing.
    let attempts = 0;
    registerTestHandler('maintenance.sweep', async (_payload, ctx) => {
      attempts += 1;
      await ctx.db.outboxMessage.create({
        data: {
          toEmail: 'interrupted@example.test',
          toName: 'Interrupted',
          subject: 'written before the kill',
          bodyText: 'x',
          template: 'invitation.sent',
          status: 'QUEUED',
        },
      });
      if (attempts === 1) {
        await ctx.db.$executeRawUnsafe('SELECT pg_terminate_backend(pg_backend_pid())');
      }
      return { ok: true };
    });

    try {
      const { job } = await enqueueJob(prisma, { type: 'maintenance.sweep', maxAttempts: 3 });
      const victim = new Worker({ client: client(), name: 'to-be-killed', batchSize: 1 });
      await victim.tick().catch(() => undefined);

      // The half-finished write is gone with the transaction that held it.
      expect(
        await prisma.outboxMessage.count({ where: { toEmail: 'interrupted@example.test' } }),
      ).toBe(0);

      // The job did not succeed, and the attempt was counted.
      const after = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });
      expect(after.status).not.toBe('SUCCEEDED');
      expect(after.attempts).toBe(1);

      // A replacement worker finishes it, and the effect exists exactly once.
      const rescuer = new Worker({ client: client(), name: 'rescuer', batchSize: 1 });
      await expect
        .poll(
          async () => {
            // The failed job carries a backoff, so it becomes due shortly; make
            // it due now rather than waiting the backoff out.
            await prisma.job.updateMany({
              where: { id: job!.id, status: { in: ['FAILED', 'RUNNING'] } },
              data: { runAt: new Date(), leaseExpiresAt: new Date(Date.now() - 60_000) },
            });
            const summary = await rescuer.tick();
            return summary.jobsSucceeded;
          },
          { timeout: 20_000, interval: 250 },
        )
        .toBe(1);

      const done = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });
      expect(done.status).toBe('SUCCEEDED');
      expect(
        await prisma.outboxMessage.count({ where: { toEmail: 'interrupted@example.test' } }),
      ).toBe(1);
    } finally {
      unregisterTestHandler('maintenance.sweep');
    }
  }, 60_000);

  it('a database connection lost mid-job leaves no partial effect', async () => {
    registerTestHandler('maintenance.sweep', async (_payload, ctx) => {
      await ctx.db.outboxMessage.create({
        data: {
          toEmail: 'partial@example.test',
          toName: 'Partial',
          subject: 'first of two writes',
          bodyText: 'x',
          template: 'invitation.sent',
          status: 'QUEUED',
        },
      });
      // The connection dies between the two writes a real handler would make.
      await ctx.db.$executeRawUnsafe('SELECT pg_terminate_backend(pg_backend_pid())');
      await ctx.db.outboxMessage.create({
        data: {
          toEmail: 'partial-second@example.test',
          toName: 'Partial',
          subject: 'second of two writes',
          bodyText: 'x',
          template: 'invitation.sent',
          status: 'QUEUED',
        },
      });
      return { ok: true };
    });

    try {
      const { job } = await enqueueJob(prisma, { type: 'maintenance.sweep', maxAttempts: 3 });
      const worker = new Worker({ client: client(), name: 'db-loss', batchSize: 1 });
      await worker.tick().catch(() => undefined);

      // Neither write survived: they were one transaction, and it did not
      // commit. A half-applied job is the thing this design exists to prevent.
      expect(
        await prisma.outboxMessage.count({
          where: { toEmail: { in: ['partial@example.test', 'partial-second@example.test'] } },
        }),
      ).toBe(0);

      // The job is recoverable rather than lost or silently succeeded.
      const after = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });
      expect(after.status).not.toBe('SUCCEEDED');
      expect(after.attempts).toBe(1);
    } finally {
      unregisterTestHandler('maintenance.sweep');
    }
  }, 60_000);

  it('recovers a queue left behind by a worker that never returned', async () => {
    // Three jobs claimed by a worker that then vanished, which is what a crash
    // during a batch leaves behind.
    for (let index = 0; index < 3; index += 1) {
      await enqueueJob(prisma, { type: 'outbox.dispatch', payload: { index }, maxAttempts: 3 });
    }
    const claimed = await claimJobs(prisma, {
      workerName: 'vanished',
      limit: 3,
      leaseSeconds: 60,
    });
    expect(claimed).toHaveLength(3);

    await prisma.job.updateMany({ data: { leaseExpiresAt: new Date(Date.now() - 60_000) } });

    // Before anything recovers them, an operator looking at the screen is told
    // rather than seeing a quiet queue.
    const health = await workerHealth(prisma);
    expect(health.runningPastLease).toBe(3);
    expect(health.warnings.some((w) => w.title.includes('past their lease'))).toBe(true);

    const reaped = await reapAbandonedJobs(prisma, { graceSeconds: 0 });
    expect(reaped.released).toBe(3);
    expect(reaped.died).toBe(0);

    // All three are queued again, each having spent exactly one attempt.
    const rows = await prisma.job.findMany();
    expect(rows.every((row) => row.status === 'FAILED')).toBe(true);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    expect(rows.every((row) => row.claimId === null)).toBe(true);
  }, 60_000);

  it('restarting a worker resumes the queue without redoing finished work', async () => {
    let runs = 0;
    registerTestHandler('maintenance.sweep', async () => {
      runs += 1;
      return { ok: true };
    });

    try {
      await enqueueJob(prisma, { type: 'maintenance.sweep', dedupeKey: 'restart:one' });
      await enqueueJob(prisma, { type: 'maintenance.sweep', dedupeKey: 'restart:two' });

      const first = new Worker({ client: client(), name: 'before-restart', batchSize: 1 });
      await first.tick();
      expect(runs).toBe(1);

      // "Restart": a brand new worker object on a new connection, as a process
      // restart produces. No in-memory state carries over.
      const second = new Worker({ client: client(), name: 'after-restart', batchSize: 5 });
      await second.tick();

      expect(runs).toBe(2);
      expect(await prisma.job.count({ where: { status: 'SUCCEEDED' } })).toBe(2);

      // A third tick finds nothing: finished work is not redone.
      await second.tick();
      expect(runs).toBe(2);
    } finally {
      unregisterTestHandler('maintenance.sweep');
    }
  }, 60_000);
});
