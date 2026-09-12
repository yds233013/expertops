import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import { enqueueJob, claimJobs } from '@/server/services/jobs';
import { Worker } from '@/server/worker/runner';
import {
  OVERDUE_AFTER_MINUTES,
  recordHeartbeat,
  STALE_AFTER_SECONDS,
  workerHealth,
} from '@/server/services/worker-health';

/**
 * Telling "nothing to do" apart from "nothing running".
 *
 * The gap: the queue tables describe work, not workers. A worker that died left
 * a quiet queue, which looks exactly like a worker with nothing to do — and the
 * difference only surfaced later, when something overdue had piled up and
 * somebody asked why nothing had happened.
 */
describe('worker health', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);

  it('says plainly when nothing has ever reported in', async () => {
    const health = await workerHealth(prisma);
    expect(health.noLiveWorker).toBe(true);
    expect(health.workers).toHaveLength(0);
    expect(health.warnings[0]!.severity).toBe('critical');
    expect(health.warnings[0]!.title).toMatch(/has ever reported in/);
    expect(health.warnings[0]!.nextAction).toMatch(/npm run worker/);
  });

  it('records a heartbeat on every tick, including one that does nothing', async () => {
    const worker = new Worker({ client: prisma, name: 'heartbeat-test' });
    await worker.tick();

    const health = await workerHealth(prisma);
    expect(health.noLiveWorker).toBe(false);
    expect(health.workers).toHaveLength(1);
    expect(health.workers[0]!.name).toBe('heartbeat-test');
    expect(health.workers[0]!.pid).toBe(process.pid);
    expect(health.workers[0]!.ticks).toBe(1);
    expect(health.workers[0]!.stalled).toBe(false);

    await worker.tick();
    expect((await workerHealth(prisma)).workers[0]!.ticks).toBe(2);
  });

  it('calls a worker stalled once it stops reporting, and says what that costs', async () => {
    await recordHeartbeat(
      prisma,
      { name: 'gone', pid: 4242, startedAt: secondsAgo(600), ticks: 99 },
      secondsAgo(STALE_AFTER_SECONDS + 30),
    );

    const health = await workerHealth(prisma);
    expect(health.workers[0]!.stalled).toBe(true);
    expect(health.noLiveWorker).toBe(true);

    const warning = health.warnings.find((entry) => entry.title === 'No worker is running')!;
    expect(warning.severity).toBe('critical');
    expect(warning.detail).toMatch(/"gone" \(pid 4242\)/);
  });

  it('distinguishes a worker that is alive but failing from one that is gone', async () => {
    await recordHeartbeat(prisma, {
      name: 'struggling',
      pid: 1,
      startedAt: secondsAgo(60),
      ticks: 5,
      lastError: 'connection terminated unexpectedly',
    });

    const health = await workerHealth(prisma);
    expect(health.noLiveWorker).toBe(false);
    const warning = health.warnings.find((entry) => entry.title.includes('last tick failed'))!;
    expect(warning.severity).toBe('warning');
    expect(warning.detail).toMatch(/connection terminated/);
    expect(warning.nextAction).toMatch(/still alive/);
  });

  it('reports overdue jobs, and escalates when nothing is running to take them', async () => {
    const { job } = await enqueueJob(prisma, { type: 'outbox.dispatch' });
    await prisma.job.update({
      where: { id: job!.id },
      data: { runAt: new Date(Date.now() - (OVERDUE_AFTER_MINUTES + 20) * 60_000) },
    });

    const dead = await workerHealth(prisma);
    expect(dead.overdueJobs).toBe(1);
    expect(dead.oldestOverdueMinutes).toBeGreaterThanOrEqual(OVERDUE_AFTER_MINUTES);
    const overdue = dead.warnings.find((entry) => entry.title.includes('overdue'))!;
    expect(overdue.severity).toBe('critical');
    expect(overdue.nextAction).toMatch(/Start a worker/);

    // The same backlog with a live worker is a warning, not an outage.
    await recordHeartbeat(prisma, { name: 'alive', pid: 1, startedAt: new Date(), ticks: 1 });
    const alive = await workerHealth(prisma);
    const stillOverdue = alive.warnings.find((entry) => entry.title.includes('overdue'))!;
    expect(stillOverdue.severity).toBe('warning');
    expect(stillOverdue.nextAction).toMatch(/failing repeatedly or backed up/);
  });

  it('reports jobs that exhausted their retries as work that will not happen', async () => {
    await prisma.job.create({
      data: { type: 'outbox.dispatch', status: 'DEAD', finishedAt: new Date(), attempts: 5 },
    });
    await recordHeartbeat(prisma, { name: 'alive', pid: 1, startedAt: new Date(), ticks: 1 });

    const health = await workerHealth(prisma);
    expect(health.deadJobs).toBe(1);
    const warning = health.warnings.find((entry) => entry.title.includes('exhausted'))!;
    expect(warning.detail).toMatch(/has not happened/);
    expect(warning.nextAction).toMatch(/retry each/);
  });

  it('reports claims whose lease has run out', async () => {
    const { job } = await enqueueJob(prisma, { type: 'outbox.dispatch' });
    await claimJobs(prisma, { workerName: 'crashed', limit: 1, leaseSeconds: 60 });
    await prisma.job.update({
      where: { id: job!.id },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
    });
    await recordHeartbeat(prisma, { name: 'alive', pid: 1, startedAt: new Date(), ticks: 1 });

    const health = await workerHealth(prisma);
    expect(health.runningPastLease).toBe(1);
    const warning = health.warnings.find((entry) => entry.title.includes('past their lease'))!;
    expect(warning.detail).toMatch(/recovered automatically/);
  });

  it('says nothing at all when everything is healthy', async () => {
    await recordHeartbeat(prisma, { name: 'alive', pid: 1, startedAt: new Date(), ticks: 10 });
    const health = await workerHealth(prisma);
    expect(health.warnings).toEqual([]);
    expect(health.noLiveWorker).toBe(false);
  });
});
