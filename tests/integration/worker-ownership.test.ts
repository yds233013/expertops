import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { applyMigrations, newClient, truncateAll } from '../helpers/db';
import {
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  reapAbandonedJobs,
  renewLease,
} from '@/server/services/jobs';
import { Worker } from '@/server/worker/runner';
import { registerTestHandler, unregisterTestHandler } from '@/server/worker/handlers';

/**
 * Job ownership under contention.
 *
 * The defect these cover: a RUNNING job could be reclaimed once its lock aged
 * out even though the first worker was still executing, and `completeJob` and
 * `failJob` then updated by job id alone. Two workers could run the same job,
 * both could write business effects, and whichever finished last decided what
 * the job's recorded outcome was.
 *
 * Every test here uses real PostgreSQL on separate connections, so the races
 * are genuine rather than simulated in memory.
 */
const clients: PrismaClient[] = [];
function client(): PrismaClient {
  const created = newClient();
  clients.push(created);
  return created;
}

/** Age a lease so the job looks abandoned, without touching anything else. */
async function expireLease(jobId: string) {
  await prisma.job.update({
    where: { id: jobId },
    data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
  });
}

describe('job ownership and recovery', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.$disconnect().catch(() => undefined)));
  });

  it('hands one job to exactly one of two workers competing for it', async () => {
    const { job } = await enqueueJob(prisma, { type: 'outbox.dispatch' });

    const [a, b] = await Promise.all([
      claimJobs(client(), { workerName: 'worker-a', limit: 5, leaseSeconds: 60 }),
      claimJobs(client(), { workerName: 'worker-b', limit: 5, leaseSeconds: 60 }),
    ]);

    const winners = [...a, ...b];
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe(job!.id);
    expect(winners[0]!.claimId).toBeTruthy();
    expect(winners[0]!.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('does not take a job over while a slow handler keeps renewing its lease', async () => {
    const { job } = await enqueueJob(prisma, { type: 'outbox.dispatch' });
    const [claim] = await claimJobs(prisma, {
      workerName: 'slow-worker',
      limit: 1,
      leaseSeconds: 1,
    });

    // Run past the original lease, renewing as a heartbeat would.
    for (let tick = 0; tick < 4; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await renewLease(prisma, job!.id, claim!.claimId, { leaseSeconds: 1 })).toBe(true);

      // At every point during that slow run, nobody else may take it.
      const intruder = await claimJobs(client(), {
        workerName: 'impatient',
        limit: 5,
        leaseSeconds: 60,
      });
      expect(intruder).toHaveLength(0);
    }

    // Elapsed time is well past the lease it was originally granted.
    expect(Date.now() - claim!.leaseExpiresAt.getTime()).toBeGreaterThan(0);
    expect(await completeJob(prisma, job!.id, claim!.claimId, { ok: true })).toBe(true);
  });

  it('recovers a genuinely abandoned claim, with a new fencing token', async () => {
    const { job } = await enqueueJob(prisma, { type: 'outbox.dispatch' });
    const [abandoned] = await claimJobs(prisma, {
      workerName: 'crashed',
      limit: 1,
      leaseSeconds: 60,
    });

    // The worker stops renewing, because it is gone.
    await expireLease(job!.id);

    const [rescued] = await claimJobs(prisma, {
      workerName: 'rescuer',
      limit: 1,
      leaseSeconds: 60,
    });
    expect(rescued!.id).toBe(job!.id);
    expect(rescued!.claimId).not.toBe(abandoned!.claimId);
    expect(rescued!.attempts).toBe(2);
  });

  it('refuses completion, failure and lease renewal from the worker that lost the job', async () => {
    const { job } = await enqueueJob(prisma, { type: 'outbox.dispatch' });
    const [stale] = await claimJobs(prisma, { workerName: 'stale', limit: 1, leaseSeconds: 60 });
    await expireLease(job!.id);
    const [current] = await claimJobs(prisma, {
      workerName: 'current',
      limit: 1,
      leaseSeconds: 60,
    });

    // Everything the stale worker tries is refused, and changes nothing.
    expect(await renewLease(prisma, job!.id, stale!.claimId)).toBe(false);
    expect(await completeJob(prisma, job!.id, stale!.claimId, { ok: 'stale' })).toBe(false);
    expect(
      await failJob(prisma, job!.id, stale!.claimId, 'stale failure', {
        attempts: 1,
        maxAttempts: 5,
      }),
    ).toBeNull();

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(after.status).toBe('RUNNING');
    expect(after.claimId).toBe(current!.claimId);
    expect(after.lastError).toBeNull();
    expect(after.result).toBeNull();

    // The rightful owner still can.
    expect(await completeJob(prisma, job!.id, current!.claimId, { ok: 'real' })).toBe(true);
    const done = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(done.status).toBe('SUCCEEDED');
    expect(done.result).toEqual({ ok: 'real' });
  });

  it('rolls back the business effects of a worker that lost its claim mid-run', async () => {
    // A handler that writes a visible effect, then waits to be overtaken.
    let released: (() => void) | null = null;
    const overtaken = new Promise<void>((resolve) => {
      released = resolve;
    });

    registerTestHandler('maintenance.sweep', async (_payload, ctx) => {
      await ctx.db.outboxMessage.create({
        data: {
          toEmail: 'effect@example.test',
          toName: 'Effect',
          subject: 'written by a doomed worker',
          bodyText: 'should not survive',
          template: 'invitation.sent',
          status: 'QUEUED',
        },
      });
      await overtaken;
      return { wrote: 1 };
    });

    try {
      const { job } = await enqueueJob(prisma, { type: 'maintenance.sweep' });
      const worker = new Worker({
        client: client(),
        name: 'doomed',
        batchSize: 1,
        leaseSeconds: 60,
        // Never renew during the test window, so the takeover below sticks.
        heartbeatIntervalMs: 60_000,
      });

      const running = worker.tick();
      // Wait until the handler has written its effect inside its transaction.
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Somebody else takes the job over while that transaction is open.
      await expireLease(job!.id);
      const [thief] = await claimJobs(prisma, {
        workerName: 'thief',
        limit: 1,
        leaseSeconds: 60,
      });
      expect(thief!.id).toBe(job!.id);

      released!();
      const summary = await running;

      expect(summary.jobsLost).toBe(1);
      expect(summary.jobsSucceeded).toBe(0);

      // The effect is gone: it was rolled back with the failed completion.
      expect(await prisma.outboxMessage.count({ where: { toEmail: 'effect@example.test' } })).toBe(
        0,
      );

      // And the job still belongs to the worker that took it over.
      const row = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });
      expect(row.status).toBe('RUNNING');
      expect(row.claimId).toBe(thief!.claimId);
    } finally {
      unregisterTestHandler('maintenance.sweep');
    }
  });

  it('produces exactly one set of business effects when two workers race the same job', async () => {
    let runs = 0;
    registerTestHandler('maintenance.sweep', async (_payload, ctx) => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
      await ctx.db.outboxMessage.create({
        data: {
          toEmail: 'once@example.test',
          toName: 'Once',
          subject: 'effect',
          bodyText: 'exactly one of these must exist',
          template: 'invitation.sent',
          status: 'QUEUED',
        },
      });
      return { ok: true };
    });

    try {
      await enqueueJob(prisma, { type: 'maintenance.sweep' });

      const one = new Worker({ client: client(), name: 'race-1', batchSize: 1, leaseSeconds: 30 });
      const two = new Worker({ client: client(), name: 'race-2', batchSize: 1, leaseSeconds: 30 });
      const [first, second] = await Promise.all([one.tick(), two.tick()]);

      expect(first.jobsSucceeded + second.jobsSucceeded).toBe(1);
      expect(runs).toBeLessThanOrEqual(2);
      // However many workers ran the handler, one effect survives.
      expect(await prisma.outboxMessage.count({ where: { toEmail: 'once@example.test' } })).toBe(1);
    } finally {
      unregisterTestHandler('maintenance.sweep');
    }
  });

  it('stops retrying a job whose worker is killed on every attempt', async () => {
    const { job } = await enqueueJob(prisma, { type: 'outbox.dispatch', maxAttempts: 3 });

    // Three abandoned claims: every one is recovered, and each costs an attempt.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await claimJobs(prisma, {
        workerName: `killed-${attempt}`,
        limit: 1,
        leaseSeconds: 60,
      });
      expect(claimed, `attempt ${attempt} should have been offered`).toHaveLength(1);
      expect(claimed[0]!.attempts).toBe(attempt);
      await expireLease(job!.id);
    }

    // The fourth is refused: recovery is bounded by maxAttempts, exactly like
    // ordinary failure.
    expect(
      await claimJobs(prisma, { workerName: 'one-too-many', limit: 1, leaseSeconds: 60 }),
    ).toHaveLength(0);

    // And the sweep stops it sitting RUNNING forever with nobody to fail it.
    const reaped = await reapAbandonedJobs(prisma, { graceSeconds: 0 });
    expect(reaped).toEqual({ released: 0, died: 1 });

    const dead = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(dead.status).toBe('DEAD');
    expect(dead.attempts).toBe(3);
    expect(dead.lastError).toMatch(/no attempts remain/i);
    expect(dead.claimId).toBeNull();
  });

  it('returns an abandoned claim to the queue while attempts remain', async () => {
    const { job } = await enqueueJob(prisma, { type: 'outbox.dispatch', maxAttempts: 5 });
    await claimJobs(prisma, { workerName: 'vanished', limit: 1, leaseSeconds: 60 });
    await expireLease(job!.id);

    const reaped = await reapAbandonedJobs(prisma, { graceSeconds: 0 });
    expect(reaped).toEqual({ released: 1, died: 0 });

    const row = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(row.status).toBe('FAILED');
    expect(row.claimId).toBeNull();
    expect(row.lastError).toMatch(/lease expired/i);
  });

  it('does not run a job whose claim was taken over while it waited behind others', async () => {
    // A batch is claimed in one statement but executed one job at a time. The
    // second job here is stolen before the worker reaches it.
    let ran = 0;
    registerTestHandler('maintenance.sweep', async () => {
      ran += 1;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { ok: true };
    });

    try {
      const first = await enqueueJob(prisma, { type: 'maintenance.sweep', priority: 1 });
      const second = await enqueueJob(prisma, { type: 'maintenance.sweep', priority: 2 });

      const worker = new Worker({
        client: client(),
        name: 'batched',
        batchSize: 2,
        leaseSeconds: 30,
        heartbeatIntervalMs: 60_000,
      });

      const running = worker.tick();

      // Wait until the worker actually holds both, rather than guessing at a
      // delay: under load the claim can take longer than a fixed sleep.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const held = await prisma.job.count({ where: { lockedBy: 'batched', status: 'RUNNING' } });
        if (held === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // Steal the second job while the worker is still busy with the first.
      await expireLease(second.job!.id);
      await claimJobs(prisma, { workerName: 'queue-jumper', limit: 1, leaseSeconds: 120 });

      const summary = await running;
      expect(summary.jobsClaimed).toBe(2);
      expect(summary.jobsSucceeded).toBe(1);
      expect(summary.jobsLost).toBe(1);
      // The stolen job's handler never ran in this worker.
      expect(ran).toBe(1);
      expect((await prisma.job.findUniqueOrThrow({ where: { id: first.job!.id } })).status).toBe(
        'SUCCEEDED',
      );
      expect((await prisma.job.findUniqueOrThrow({ where: { id: second.job!.id } })).status).toBe(
        'RUNNING',
      );
    } finally {
      unregisterTestHandler('maintenance.sweep');
    }
  });
});

/**
 * Job history retention.
 *
 * The table grows by roughly one row per scheduled tick per schedule, which at
 * the shipped intervals is a few thousand rows a day. The policy is pinned here
 * rather than left implicit, because the two things that must never be pruned —
 * failures, and the deduplication keys that make "enqueue once" a database
 * guarantee — are exactly the things a naive cleanup would remove first.
 */
describe('job history retention', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('keeps failures and dead letters, and prunes only settled successes', async () => {
    const { pruneFinishedJobs } = await import('@/server/services/jobs');
    const old = new Date(Date.now() - 30 * 86_400_000);
    const recent = new Date();

    await prisma.job.createMany({
      data: [
        { type: 'outbox.dispatch', status: 'SUCCEEDED', finishedAt: old },
        { type: 'outbox.dispatch', status: 'CANCELLED', finishedAt: old },
        { type: 'outbox.dispatch', status: 'DEAD', finishedAt: old },
        { type: 'outbox.dispatch', status: 'FAILED', finishedAt: old },
        { type: 'outbox.dispatch', status: 'SUCCEEDED', finishedAt: recent },
      ],
    });

    const pruned = await pruneFinishedJobs(prisma, new Date(Date.now() - 7 * 86_400_000));
    expect(pruned).toBe(2);

    // A failure is evidence. It is never pruned by age, however old.
    expect(await prisma.job.count({ where: { status: 'DEAD' } })).toBe(1);
    expect(await prisma.job.count({ where: { status: 'FAILED' } })).toBe(1);
    // A recent success is kept until it ages out.
    expect(await prisma.job.count({ where: { status: 'SUCCEEDED' } })).toBe(1);
  });

  it('frees a deduplication key only when its job is pruned, which is why keys are time-scoped', async () => {
    // Schedule keys carry a tick bucket, so a key freed by pruning can never
    // collide with a live one. This test documents that dependency: if pruning
    // ever removed a job whose key was still meaningful, the second enqueue
    // below would create a duplicate rather than deduplicate.
    const { pruneFinishedJobs } = await import('@/server/services/jobs');
    const key = 'schedule:outbox-dispatch:1700000000';

    const first = await enqueueJob(prisma, { type: 'outbox.dispatch', dedupeKey: key });
    const second = await enqueueJob(prisma, { type: 'outbox.dispatch', dedupeKey: key });
    expect(second.deduplicated).toBe(true);
    expect(await prisma.job.count({ where: { dedupeKey: key } })).toBe(1);

    await prisma.job.update({
      where: { id: first.job!.id },
      data: { status: 'SUCCEEDED', finishedAt: new Date(Date.now() - 30 * 86_400_000) },
    });
    expect(await pruneFinishedJobs(prisma, new Date(Date.now() - 7 * 86_400_000))).toBe(1);

    // The key is now free. A future tick uses a different bucket, so this only
    // matters if a caller reuses a key verbatim.
    const third = await enqueueJob(prisma, { type: 'outbox.dispatch', dedupeKey: key });
    expect(third.deduplicated).toBe(false);
  });
});
