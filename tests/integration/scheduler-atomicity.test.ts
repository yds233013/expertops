import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { applyMigrations, newClient, truncateAll } from '../helpers/db';
import { ensureDefaultSchedules, tickSchedules } from '@/server/services/schedules';

/**
 * Claiming a schedule and creating its job are one transaction.
 *
 * The defect: `nextRunAt` was advanced by one statement and the job created by
 * another. A failure in between consumed the scheduled execution — the schedule
 * looked as though it had run, no job existed, and nothing would happen until
 * the next interval came round. For a nightly schedule that is a day of silence
 * that reports itself as healthy.
 */
const clients: PrismaClient[] = [];
function client(): PrismaClient {
  const created = newClient();
  clients.push(created);
  return created;
}

/** A single enabled schedule, due now, with everything else switched off. */
async function oneDueSchedule(name = 'outbox-dispatch') {
  await ensureDefaultSchedules(prisma);
  await prisma.schedule.updateMany({ data: { enabled: false } });
  await prisma.schedule.update({
    where: { name },
    data: { enabled: true, nextRunAt: new Date(Date.now() - 1000), lastJobId: null },
  });
  return prisma.schedule.findUniqueOrThrow({ where: { name } });
}

describe('scheduler atomicity', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.$disconnect().catch(() => undefined)));
  });

  it('does not consume the scheduled execution when the enqueue fails', async () => {
    const schedule = await oneDueSchedule();
    const before = schedule.nextRunAt;

    // Make the job insert fail the way a real one might: a constraint it cannot
    // satisfy. The dedupe key this tick will use is already taken by a row of a
    // different type, so `enqueueJob` finds the existing row and reports a
    // deduplication rather than an error — so instead break the table itself
    // for the duration of the transaction.
    const now = new Date();
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Job" ADD CONSTRAINT tmp_block_inserts CHECK (type <> \'outbox.dispatch\')',
    );

    let result;
    try {
      result = await tickSchedules(prisma, { now });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "Job" DROP CONSTRAINT tmp_block_inserts');
    }

    expect(result.enqueued).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.name).toBe('outbox-dispatch');

    // No job was created, and crucially the schedule is still due: the tick was
    // rolled back rather than silently consumed.
    expect(await prisma.job.count()).toBe(0);
    const after = await prisma.schedule.findUniqueOrThrow({ where: { name: 'outbox-dispatch' } });
    expect(after.nextRunAt.getTime()).toBe(before.getTime());
    expect(after.lastJobId).toBeNull();

    // The next tick, with the fault cleared, does the work.
    const recovered = await tickSchedules(prisma, { now: new Date(now.getTime() + 1000) });
    expect(recovered.enqueued).toBe(1);
    expect(await prisma.job.count({ where: { type: 'outbox.dispatch' } })).toBe(1);
  });

  it('fires a schedule once when several workers tick at the same instant', async () => {
    await oneDueSchedule();
    const now = new Date();

    const results = await Promise.all([
      tickSchedules(client(), { now }),
      tickSchedules(client(), { now }),
      tickSchedules(client(), { now }),
      tickSchedules(client(), { now }),
    ]);

    const enqueued = results.reduce((total, result) => total + result.enqueued, 0);
    expect(enqueued).toBe(1);
    expect(await prisma.job.count({ where: { type: 'outbox.dispatch' } })).toBe(1);

    // Whoever won advanced the schedule exactly one interval.
    const after = await prisma.schedule.findUniqueOrThrow({ where: { name: 'outbox-dispatch' } });
    expect(after.nextRunAt.getTime()).toBe(now.getTime() + after.intervalSeconds * 1000);
    expect(after.lastJobId).toBeTruthy();
  });

  it('records the job it created, in the same transaction that advanced the schedule', async () => {
    await oneDueSchedule();
    const result = await tickSchedules(prisma, { now: new Date() });
    expect(result.enqueued).toBe(1);

    const after = await prisma.schedule.findUniqueOrThrow({ where: { name: 'outbox-dispatch' } });
    const job = await prisma.job.findFirstOrThrow({ where: { type: 'outbox.dispatch' } });
    expect(after.lastJobId).toBe(job.id);
  });

  it('recovers on restart: a schedule left due still fires, exactly once', async () => {
    const schedule = await oneDueSchedule();
    // A worker died before ticking: the schedule is due and nothing exists.
    expect(schedule.lastJobId).toBeNull();
    expect(await prisma.job.count()).toBe(0);

    // Restart. Two ticks in a row, as a restarted worker would do.
    const first = await tickSchedules(prisma, { now: new Date() });
    const second = await tickSchedules(prisma, { now: new Date() });

    expect(first.enqueued).toBe(1);
    expect(second.enqueued).toBe(0);
    expect(await prisma.job.count({ where: { type: 'outbox.dispatch' } })).toBe(1);
  });

  it('does not let one broken schedule stall the others', async () => {
    await ensureDefaultSchedules(prisma);
    await prisma.schedule.updateMany({ data: { enabled: false } });
    await prisma.schedule.updateMany({
      where: { name: { in: ['outbox-dispatch', 'attention-sweep'] } },
      data: { enabled: true, nextRunAt: new Date(Date.now() - 1000) },
    });

    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Job" ADD CONSTRAINT tmp_block_one CHECK (type <> \'outbox.dispatch\')',
    );
    let result;
    try {
      result = await tickSchedules(prisma, { now: new Date() });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "Job" DROP CONSTRAINT tmp_block_one');
    }

    expect(result.failed.map((entry) => entry.name)).toEqual(['outbox-dispatch']);
    expect(result.enqueued).toBe(1);
    expect(await prisma.job.count({ where: { type: 'attention.sweep' } })).toBe(1);
    // The broken one is still due and will be retried.
    const broken = await prisma.schedule.findUniqueOrThrow({ where: { name: 'outbox-dispatch' } });
    expect(broken.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
