import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import { actorFor, makeExpert, makeOperator, makeProject } from '../helpers/factories';
import {
  createInvitation,
  respondToInvitation,
  sendInvitation,
} from '@/server/services/invitations';
import { SYSTEM_ACTOR } from '@/server/services/activity';
import { readFile } from 'node:fs/promises';
import {
  enqueueJob,
  failJob,
  jobCounts,
  JOB_TYPES,
  listJobs,
  pruneFinishedJobs,
  retryJob,
} from '@/server/services/jobs';
import {
  DEFAULT_SCHEDULES,
  ensureDefaultSchedules,
  listSchedules,
  setScheduleEnabled,
  tickSchedules,
} from '@/server/services/schedules';
import { HANDLERS } from '@/server/worker/handlers';
import { Worker } from '@/server/worker/runner';

/**
 * Worker behaviour against real PostgreSQL: scheduling, claiming, retries,
 * dead-lettering, and the handlers actually doing the workflow steps.
 */
describe('worker: scheduling', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('registers every default schedule on bootstrap, idempotently', async () => {
    const worker = new Worker({ client: prisma, name: 'bootstrap-test' });
    await worker.bootstrap();
    await worker.bootstrap();

    const schedules = await listSchedules(prisma);
    expect(schedules).toHaveLength(DEFAULT_SCHEDULES.length);
    expect(schedules.map((schedule) => schedule.name).sort()).toEqual(
      DEFAULT_SCHEDULES.map((schedule) => schedule.name).sort(),
    );
  });

  it('enqueues a job per due schedule and advances nextRunAt', async () => {
    await ensureDefaultSchedules(prisma);
    const now = new Date();

    const result = await tickSchedules(prisma, { now });
    expect(result.enqueued).toBe(DEFAULT_SCHEDULES.length);

    const schedules = await listSchedules(prisma);
    for (const schedule of schedules) {
      expect(schedule.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
      expect(schedule.lastRunAt).not.toBeNull();
    }
  });

  it('does not re-fire a schedule before its interval elapses', async () => {
    await ensureDefaultSchedules(prisma);
    const now = new Date();

    await tickSchedules(prisma, { now });
    const second = await tickSchedules(prisma, { now: new Date(now.getTime() + 1000) });

    expect(second.enqueued).toBe(0);
  });

  it('fires again once the interval has passed', async () => {
    await ensureDefaultSchedules(prisma);
    const now = new Date();
    await tickSchedules(prisma, { now });

    const later = new Date(now.getTime() + 3600_000 + 1000);
    const again = await tickSchedules(prisma, { now: later });
    expect(again.enqueued).toBe(DEFAULT_SCHEDULES.length);
  });

  it('skips a disabled schedule', async () => {
    await ensureDefaultSchedules(prisma);
    await setScheduleEnabled(prisma, 'outbox-dispatch', false);
    await prisma.schedule.updateMany({ data: { nextRunAt: new Date(Date.now() - 1000) } });

    const result = await tickSchedules(prisma);
    expect(result.scheduleNames).not.toContain('outbox-dispatch');
    expect(result.enqueued).toBe(DEFAULT_SCHEDULES.length - 1);
  });

  it('does not replay a backlog after the worker was offline', async () => {
    await ensureDefaultSchedules(prisma);
    // Schedule was due a day ago; one tick should catch up with one job each,
    // not one job per missed interval.
    await prisma.schedule.updateMany({
      data: { nextRunAt: new Date(Date.now() - 86_400_000) },
    });

    const result = await tickSchedules(prisma);
    expect(result.enqueued).toBe(DEFAULT_SCHEDULES.length);
    expect(await prisma.job.count()).toBe(DEFAULT_SCHEDULES.length);
  });
});

describe('worker: job execution', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('has a handler for every registered job type', () => {
    for (const schedule of DEFAULT_SCHEDULES) {
      expect(HANDLERS[schedule.jobType]).toBeTypeOf('function');
    }
  });

  it('registers a handler for every declared job type', () => {
    for (const type of JOB_TYPES) {
      expect(HANDLERS[type], `no handler for ${type}`).toBeTypeOf('function');
    }
  });

  it('declares no job type that is a no-op masquerading as a business action', async () => {
    // The original build shipped two job types that always reported success
    // while doing nothing. Both were removed rather than left to look healthy
    // on the Worker screen. This test stops them coming back.
    const source = await readFile('src/server/worker/handlers.ts', 'utf8');
    expect(source).not.toContain('not implemented in this slice');

    expect(JOB_TYPES).not.toContain('assignment.notify' as never);
    expect(JOB_TYPES).not.toContain('onboarding.notify_decision' as never);

    // The jobs that the original requirements actually asked for do exist.
    expect(JOB_TYPES).toContain('invitation.remind');
    expect(JOB_TYPES).toContain('invitation.expire');
    expect(JOB_TYPES).toContain('onboarding.nudge');
    expect(JOB_TYPES).toContain('staffing.detect_gaps');
  });

  it('sends a queued invitation through the invitation.send job', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });

    const worker = new Worker({ client: prisma, name: 'send-test', batchSize: 10 });
    const summary = await worker.tick();

    expect(summary.jobsSucceeded).toBeGreaterThanOrEqual(1);
    expect(summary.jobsFailed).toBe(0);
    expect(
      (await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status,
    ).toBe('SENT');
    expect(await prisma.outboxMessage.count({ where: { template: 'invitation.sent' } })).toBe(1);
  });

  it('marks queued outbox messages as delivered without contacting anything', async () => {
    await prisma.outboxMessage.create({
      data: {
        toEmail: 'someone@example.test',
        subject: 'Test',
        bodyText: 'body',
        template: 'invitation.sent',
      },
    });
    await enqueueJob(prisma, { type: 'outbox.dispatch' });

    const worker = new Worker({ client: prisma, name: 'dispatch-test' });
    await worker.tick();

    const message = await prisma.outboxMessage.findFirstOrThrow();
    expect(message.status).toBe('SENT');
    expect(message.sentAt).not.toBeNull();
    expect(message.attempts).toBe(1);
  });

  it('expires overdue invitations through the scheduled job', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await enqueueJob(prisma, { type: 'invitation.expire' });
    const worker = new Worker({ client: prisma, name: 'expire-test', batchSize: 10 });
    await worker.tick();

    expect(
      (await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status,
    ).toBe('EXPIRED');
    expect(await prisma.activityEvent.count({ where: { action: 'invitation.expired' } })).toBe(1);
  });

  it('opens the onboarding checklist and emails a portal link after acceptance', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
    await respondToInvitation(prisma, expert.id, { invitationId: invitation.id, accept: true });

    const worker = new Worker({ client: prisma, name: 'onboarding-test', batchSize: 10 });
    await worker.tick();

    const onboardingEmail = await prisma.outboxMessage.findFirst({
      where: { template: 'onboarding.start', expertId: expert.id },
    });
    expect(onboardingEmail).not.toBeNull();
    expect(onboardingEmail!.devPortalUrl).toContain('/portal/enter/');
  });

  it('nudges a stalled onboarding case once per interval', async () => {
    const expert = await makeExpert({ status: 'ONBOARDING' });
    await prisma.onboardingCase.create({
      data: {
        expertId: expert.id,
        status: 'IN_PROGRESS',
        createdAt: new Date(Date.now() - 48 * 3_600_000),
        items: {
          create: [
            {
              key: 'nda_accepted',
              label: 'Accept the mutual non-disclosure terms',
              kind: 'ATTESTATION',
              required: true,
              position: 0,
            },
          ],
        },
      },
    });

    await enqueueJob(prisma, { type: 'onboarding.nudge', payload: { nudgeAfterHours: 24 } });
    const worker = new Worker({ client: prisma, name: 'nudge-test', batchSize: 10 });
    await worker.tick();

    expect(await prisma.outboxMessage.count({ where: { template: 'onboarding.nudge' } })).toBe(1);

    // A second run inside the window does not nudge again.
    await enqueueJob(prisma, { type: 'onboarding.nudge', payload: { nudgeAfterHours: 24 } });
    await worker.tick();
    expect(await prisma.outboxMessage.count({ where: { template: 'onboarding.nudge' } })).toBe(1);
  });

  it('purges expired sessions in the maintenance sweep', async () => {
    const operator = await makeOperator();
    await prisma.session.create({
      data: {
        userId: operator.id,
        tokenHash: 'expired-hash',
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    await enqueueJob(prisma, { type: 'maintenance.sweep' });
    const worker = new Worker({ client: prisma, name: 'sweep-test', batchSize: 10 });
    await worker.tick();

    expect(await prisma.session.count()).toBe(0);
  });
});

describe('worker: long-running loop', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('keeps running between polls instead of exiting when the queue is empty', async () => {
    const worker = new Worker({ client: prisma, name: 'loop-test', pollIntervalMs: 50 });

    let finished = false;
    const running = worker.start().then(() => {
      finished = true;
    });

    // Give it several idle poll intervals. A worker whose poll timer does not
    // hold the event loop open would have fallen out of the loop by now.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(finished).toBe(false);

    worker.stop();
    await running;
    expect(finished).toBe(true);
  });

  it('picks up work enqueued while it is idling', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });

    const worker = new Worker({ client: prisma, name: 'idle-pickup', pollIntervalMs: 50 });
    const running = worker.start();

    await new Promise((resolve) => setTimeout(resolve, 150));
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });

    const deadline = Date.now() + 5000;
    let status = 'DRAFT';
    while (Date.now() < deadline && status !== 'SENT') {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = (await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status;
    }

    worker.stop();
    await running;
    expect(status).toBe('SENT');
  });

  it('stops promptly rather than waiting out the poll interval', async () => {
    const worker = new Worker({ client: prisma, name: 'stop-test', pollIntervalMs: 5000 });
    const running = worker.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const startedAt = Date.now();
    worker.stop();
    await running;
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

describe('worker: failure handling', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('retries a failing job with backoff, then dead-letters it', async () => {
    // A payload that no handler can satisfy: the invitation does not exist.
    const { job } = await enqueueJob(prisma, {
      type: 'invitation.send',
      payload: { invitationId: 'missing' },
      maxAttempts: 3,
    });

    const worker = new Worker({ client: prisma, name: 'retry-test', batchSize: 5 });

    // Attempt 1: fails, scheduled for a retry.
    await worker.tick();
    let stored = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(stored.status).toBe('FAILED');
    expect(stored.attempts).toBe(1);
    expect(stored.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(stored.lastError).toContain('Invitation not found');

    // Fast-forward past the backoff twice more to exhaust the attempts.
    for (let round = 0; round < 2; round += 1) {
      await prisma.job.update({ where: { id: job!.id }, data: { runAt: new Date() } });
      await worker.tick();
      stored = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });
    }

    expect(stored.status).toBe('DEAD');
    expect(stored.attempts).toBe(3);
    expect(stored.finishedAt).not.toBeNull();
  });

  it('does not claim a dead job again', async () => {
    const { job } = await enqueueJob(prisma, {
      type: 'invitation.send',
      payload: { invitationId: 'missing' },
      maxAttempts: 1,
    });
    const worker = new Worker({ client: prisma, name: 'dead-test' });
    await worker.tick();
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job!.id } })).status).toBe('DEAD');

    const summary = await worker.tick();
    expect(summary.jobsClaimed).toBe(0);
  });

  it('lets an operator retry a dead job and succeed', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });

    // Break the job, run it to death, then repair the payload and retry.
    const job = await prisma.job.findFirstOrThrow({ where: { type: 'invitation.send' } });
    await prisma.job.update({
      where: { id: job.id },
      data: { payload: { invitationId: 'missing' }, maxAttempts: 1 },
    });

    const worker = new Worker({ client: prisma, name: 'repair-test', batchSize: 5 });
    await worker.tick();
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('DEAD');

    await prisma.job.update({
      where: { id: job.id },
      data: { payload: { invitationId: invitation.id }, maxAttempts: 3 },
    });
    await retryJob(prisma, job.id);
    await worker.tick();

    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
      'SUCCEEDED',
    );
    expect(
      (await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status,
    ).toBe('SENT');
  });

  it('dead-letters a job with no registered handler', async () => {
    const job = await prisma.job.create({
      data: { type: 'not.a.real.job', maxAttempts: 1 },
    });
    const worker = new Worker({ client: prisma, name: 'unknown-test' });
    const summary = await worker.tick();

    expect(summary.unknownTypes).toBe(1);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe('DEAD');
    expect(stored.lastError).toContain('No handler registered');
  });

  it('rejects a malformed job payload with a readable error', async () => {
    const { job } = await enqueueJob(prisma, {
      type: 'matching.run',
      payload: { notAProjectId: true },
      maxAttempts: 1,
    });
    const worker = new Worker({ client: prisma, name: 'payload-test' });
    await worker.tick();

    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(stored.status).toBe('DEAD');
    expect(stored.lastError).toContain('Invalid payload for job "matching.run"');
  });

  it('prunes old finished jobs but keeps failures for inspection', async () => {
    const old = new Date(Date.now() - 30 * 86_400_000);
    await prisma.job.createMany({
      data: [
        { type: 'outbox.dispatch', status: 'SUCCEEDED', finishedAt: old },
        { type: 'outbox.dispatch', status: 'CANCELLED', finishedAt: old },
        { type: 'outbox.dispatch', status: 'DEAD', finishedAt: old },
        { type: 'outbox.dispatch', status: 'SUCCEEDED', finishedAt: new Date() },
      ],
    });

    const pruned = await pruneFinishedJobs(prisma, new Date(Date.now() - 7 * 86_400_000));
    expect(pruned).toBe(2);

    const counts = await jobCounts(prisma);
    expect(counts.DEAD).toBe(1);
    expect(counts.SUCCEEDED).toBe(1);
  });

  it('records the failure reason on the job for the operator UI', async () => {
    const { job } = await enqueueJob(prisma, { type: 'outbox.dispatch' });
    await failJob(prisma, job!.id, 'connection reset by peer', { attempts: 1, maxAttempts: 5 });

    const listed = await listJobs(prisma, { status: 'FAILED' });
    expect(listed.jobs).toHaveLength(1);
    expect(listed.jobs[0]!.lastError).toBe('connection reset by peer');
  });
});
