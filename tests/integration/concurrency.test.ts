import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { type AppError } from '@/lib/errors';
import { applyMigrations, newClient, truncateAll } from '../helpers/db';
import {
  actorFor,
  makeExpert,
  makeOperator,
  makeProject,
  makeStaffableExpert,
} from '../helpers/factories';
import { SYSTEM_ACTOR } from '@/server/services/activity';
import {
  createInvitation,
  respondToInvitation,
  sendInvitation,
} from '@/server/services/invitations';
import { claimJobs, completeJob, enqueueJob } from '@/server/services/jobs';
import { decideVerification } from '@/server/services/onboarding';
import { dispatchQueuedMessages } from '@/server/services/outbox';
import { issuePortalToken, redeemPortalToken } from '@/server/services/portal-access';
import { confirmAssignment, proposeAssignment } from '@/server/services/staffing';
import { ensureDefaultSchedules, tickSchedules } from '@/server/services/schedules';
import { Worker } from '@/server/worker/runner';

/**
 * Concurrency behaviour against a real PostgreSQL instance.
 *
 * Several of these use a second Prisma client on its own connection, so the
 * races are genuinely concurrent at the database level rather than interleaved
 * inside one connection pool slot.
 */
const clients: PrismaClient[] = [];

function extraClient(): PrismaClient {
  const client = newClient();
  clients.push(client);
  return client;
}

function settledErrors(results: PromiseSettledResult<unknown>[]): AppError[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason as AppError);
}

describe('concurrency: seat capacity', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.$disconnect()));
  });

  it('gives the last seat to exactly one of two simultaneous confirmations', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 1 });

    const expertA = await makeStaffableExpert(project.id);
    const expertB = await makeStaffableExpert(project.id);

    const proposalA = await proposeAssignment(prisma, actor, {
      projectId: project.id,
      expertId: expertA.id,
      allocationHoursPerWeek: 10,
    });
    const proposalB = await proposeAssignment(prisma, actor, {
      projectId: project.id,
      expertId: expertB.id,
      allocationHoursPerWeek: 10,
    });

    // Two operators on two connections click "confirm" at the same instant.
    const clientOne = extraClient();
    const clientTwo = extraClient();

    const results = await Promise.allSettled([
      confirmAssignment(clientOne, actor, proposalA.id),
      confirmAssignment(clientTwo, actor, proposalB.id),
    ]);

    const succeeded = results.filter((result) => result.status === 'fulfilled');
    const failed = settledErrors(results);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.code).toBe('CAPACITY_EXCEEDED');

    const finalProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(finalProject.seatsFilled).toBe(1);

    const confirmed = await prisma.assignment.count({
      where: { projectId: project.id, status: 'CONFIRMED' },
    });
    expect(confirmed).toBe(1);
  });

  it('never oversubscribes when many confirmations race for a few seats', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const SEATS = 3;
    const CONTENDERS = 8;
    const project = await makeProject(operator.id, {
      status: 'STAFFING',
      seatsRequested: SEATS,
    });

    const proposals = [];
    for (let index = 0; index < CONTENDERS; index += 1) {
      const expert = await makeStaffableExpert(project.id);
      proposals.push(
        await proposeAssignment(prisma, actor, {
          projectId: project.id,
          expertId: expert.id,
          allocationHoursPerWeek: 10,
        }),
      );
    }

    const pool = Array.from({ length: 4 }, () => extraClient());
    const results = await Promise.allSettled(
      proposals.map((proposal, index) =>
        confirmAssignment(pool[index % pool.length]!, actor, proposal.id),
      ),
    );

    const succeeded = results.filter((result) => result.status === 'fulfilled');
    const failed = settledErrors(results);

    expect(succeeded).toHaveLength(SEATS);
    expect(failed).toHaveLength(CONTENDERS - SEATS);
    for (const error of failed) {
      expect(error.code).toBe('CAPACITY_EXCEEDED');
    }

    const finalProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(finalProject.seatsFilled).toBe(SEATS);
    expect(
      await prisma.assignment.count({ where: { projectId: project.id, status: 'CONFIRMED' } }),
    ).toBe(SEATS);
  });

  it('records exactly one confirmation event per successful seat', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 2 });

    const proposals = [];
    for (let index = 0; index < 4; index += 1) {
      const expert = await makeStaffableExpert(project.id);
      proposals.push(
        await proposeAssignment(prisma, actor, {
          projectId: project.id,
          expertId: expert.id,
          allocationHoursPerWeek: 8,
        }),
      );
    }

    const pool = [extraClient(), extraClient()];
    await Promise.allSettled(
      proposals.map((proposal, index) => confirmAssignment(pool[index % 2]!, actor, proposal.id)),
    );

    const confirmations = await prisma.activityEvent.count({
      where: { projectId: project.id, action: 'assignment.confirmed' },
    });
    expect(confirmations).toBe(2);

    // One simulated email per confirmed seat - no duplicates from rolled-back
    // transactions.
    expect(
      await prisma.outboxMessage.count({
        where: { projectId: project.id, template: 'assignment.confirmed' },
      }),
    ).toBe(2);
  });

  it('confirming the same assignment twice at once succeeds only once', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 5 });
    const expert = await makeStaffableExpert(project.id);
    const proposal = await proposeAssignment(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
      allocationHoursPerWeek: 10,
    });

    const clientOne = extraClient();
    const clientTwo = extraClient();
    const results = await Promise.allSettled([
      confirmAssignment(clientOne, actor, proposal.id),
      confirmAssignment(clientTwo, actor, proposal.id),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).seatsFilled,
    ).toBe(1);
  });
});

describe('concurrency: invitations and verification', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('accepts an invitation only once when the expert double-clicks', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });

    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);

    const clientOne = extraClient();
    const clientTwo = extraClient();
    const results = await Promise.allSettled([
      respondToInvitation(clientOne, expert.id, { invitationId: invitation.id, accept: true }),
      respondToInvitation(clientTwo, expert.id, { invitationId: invitation.id, accept: true }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.activityEvent.count({ where: { action: 'invitation.accepted' } })).toBe(1);
  });

  it('lets only one of a simultaneous accept and decline win', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });

    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);

    const clientOne = extraClient();
    const clientTwo = extraClient();
    const results = await Promise.allSettled([
      respondToInvitation(clientOne, expert.id, { invitationId: invitation.id, accept: true }),
      respondToInvitation(clientTwo, expert.id, {
        invitationId: invitation.id,
        accept: false,
        declineReason: 'No longer free',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const final = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(['ACCEPTED', 'DECLINED']).toContain(final.status);
  });

  it('creates only one invitation when two operators invite the same expert at once', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });

    const clientOne = extraClient();
    const clientTwo = extraClient();
    const results = await Promise.allSettled([
      createInvitation(clientOne, actor, { projectId: project.id, expertId: expert.id }),
      createInvitation(clientTwo, actor, { projectId: project.id, expertId: expert.id }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settledErrors(results)[0]!.code).toBe('CONFLICT');
    expect(await prisma.invitation.count({ where: { projectId: project.id } })).toBe(1);
  });

  it('lets only one operator decide a verification case', async () => {
    const operatorOne = await makeOperator({ name: 'First Operator' });
    const operatorTwo = await makeOperator({ name: 'Second Operator' });
    const expert = await makeExpert({ status: 'PENDING_VERIFICATION' });
    await prisma.onboardingCase.create({
      data: { expertId: expert.id, status: 'SUBMITTED', submittedAt: new Date() },
    });

    const clientOne = extraClient();
    const clientTwo = extraClient();
    const results = await Promise.allSettled([
      decideVerification(clientOne, actorFor(operatorOne), { expertId: expert.id, approve: true }),
      decideVerification(clientTwo, actorFor(operatorTwo), {
        expertId: expert.id,
        approve: false,
        note: 'Missing billing reference',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const decided = await prisma.onboardingCase.findUniqueOrThrow({
      where: { expertId: expert.id },
    });
    expect(['VERIFIED', 'REJECTED']).toContain(decided.status);
    expect(decided.verifiedById).not.toBeNull();
  });

  it('redeems a portal link once even under a simultaneous double click', async () => {
    const expert = await makeExpert();
    const issued = await issuePortalToken(prisma, { expertId: expert.id });

    const clientOne = extraClient();
    const clientTwo = extraClient();
    const results = await Promise.allSettled([
      redeemPortalToken(clientOne, issued.token),
      redeemPortalToken(clientTwo, issued.token),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.expertPortalSession.count({ where: { expertId: expert.id } })).toBe(1);
  });
});

describe('concurrency: job queue', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('never hands the same job to two workers', async () => {
    for (let index = 0; index < 20; index += 1) {
      await enqueueJob(prisma, { type: 'outbox.dispatch', payload: { index } });
    }

    const workers = [extraClient(), extraClient(), extraClient(), extraClient()];
    const batches = await Promise.all(
      workers.map((client, index) =>
        claimJobs(client, {
          workerName: `worker-${index}`,
          limit: 10,
          lockTimeoutSeconds: 60,
        }),
      ),
    );

    const claimedIds = batches.flat().map((job) => job.id);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds.length).toBeLessThanOrEqual(20);
    expect(claimedIds.length).toBeGreaterThan(0);
  });

  it('claims every job exactly once when workers drain the queue together', async () => {
    const TOTAL = 30;
    for (let index = 0; index < TOTAL; index += 1) {
      await enqueueJob(prisma, { type: 'outbox.dispatch', payload: { index } });
    }

    const workers = [extraClient(), extraClient(), extraClient()];
    const seen = new Set<string>();

    // Keep claiming until the queue is empty, in parallel across workers.
    for (let round = 0; round < 20; round += 1) {
      const batches = await Promise.all(
        workers.map((client, index) =>
          claimJobs(client, {
            workerName: `drainer-${index}`,
            limit: 5,
            lockTimeoutSeconds: 300,
          }),
        ),
      );
      const claimed = batches.flat();
      if (claimed.length === 0) break;
      for (const job of claimed) {
        expect(seen.has(job.id), `job ${job.id} was claimed twice`).toBe(false);
        seen.add(job.id);
        await completeJob(prisma, job.id, { ok: true });
      }
    }

    expect(seen.size).toBe(TOTAL);
    expect(await prisma.job.count({ where: { status: 'SUCCEEDED' } })).toBe(TOTAL);
  });

  it('deduplicates enqueues that share a dedupe key', async () => {
    const clientsToRace = [prisma, extraClient(), extraClient(), extraClient()];
    const results = await Promise.all(
      clientsToRace.map(() =>
        enqueueJob(prisma, {
          type: 'outbox.dispatch',
          dedupeKey: 'shared-key',
        }),
      ),
    );

    expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
    expect(await prisma.job.count({ where: { dedupeKey: 'shared-key' } })).toBe(1);
  });

  it('reclaims a job whose worker died mid-run', async () => {
    const { job } = await enqueueJob(prisma, { type: 'outbox.dispatch' });

    const first = await claimJobs(prisma, {
      workerName: 'doomed-worker',
      limit: 5,
      lockTimeoutSeconds: 60,
    });
    expect(first).toHaveLength(1);

    // No second worker may take it while the lock is fresh.
    expect(
      await claimJobs(prisma, { workerName: 'other', limit: 5, lockTimeoutSeconds: 60 }),
    ).toHaveLength(0);

    // Simulate the worker dying: age the lock past the timeout.
    await prisma.job.update({
      where: { id: job!.id },
      data: { lockedAt: new Date(Date.now() - 10 * 60_000) },
    });

    const reclaimed = await claimJobs(prisma, {
      workerName: 'rescuer',
      limit: 5,
      lockTimeoutSeconds: 60,
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.id).toBe(job!.id);
    expect(reclaimed[0]!.attempts).toBe(2);
  });

  it('fires a schedule once even when several workers tick at the same moment', async () => {
    await ensureDefaultSchedules(prisma);
    await prisma.schedule.updateMany({ data: { nextRunAt: new Date(Date.now() - 1000) } });
    const scheduleCount = await prisma.schedule.count();

    const now = new Date();
    const workers = [extraClient(), extraClient(), extraClient()];
    const results = await Promise.all(workers.map((client) => tickSchedules(client, { now })));

    const totalEnqueued = results.reduce((sum, result) => sum + result.enqueued, 0);
    expect(totalEnqueued).toBe(scheduleCount);

    const jobs = await prisma.job.findMany();
    expect(jobs).toHaveLength(scheduleCount);
    expect(new Set(jobs.map((job) => job.dedupeKey)).size).toBe(scheduleCount);
  });

  it('delivers each simulated email once when dispatchers overlap', async () => {
    for (let index = 0; index < 12; index += 1) {
      await prisma.outboxMessage.create({
        data: {
          toEmail: `expert-${index}@example.test`,
          subject: `Message ${index}`,
          bodyText: 'body',
          template: 'invitation.sent',
        },
      });
    }

    const dispatchers = [extraClient(), extraClient(), extraClient()];
    const results = await Promise.all(
      dispatchers.map((client) => dispatchQueuedMessages(client, { limit: 12 })),
    );

    const totalDelivered = results.reduce((sum, result) => sum + result.delivered, 0);
    expect(totalDelivered).toBe(12);

    const messages = await prisma.outboxMessage.findMany();
    expect(messages.every((message) => message.status === 'SENT')).toBe(true);
    expect(messages.every((message) => message.attempts === 1)).toBe(true);
  });

  it('runs two full workers side by side without duplicating work', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'MATCHING' });

    for (let index = 0; index < 5; index += 1) {
      const expert = await makeExpert({
        skills: [{ name: 'Distributed Systems', proficiency: 4 }],
      });
      await createInvitation(prisma, actor, { projectId: project.id, expertId: expert.id });
    }

    const workerOne = new Worker({ client: extraClient(), name: 'w1', batchSize: 3 });
    const workerTwo = new Worker({ client: extraClient(), name: 'w2', batchSize: 3 });
    await workerOne.bootstrap();

    for (let round = 0; round < 6; round += 1) {
      await Promise.all([workerOne.tick(), workerTwo.tick()]);
    }

    // Each invitation was sent exactly once.
    const invitations = await prisma.invitation.findMany({ where: { projectId: project.id } });
    expect(invitations.every((invitation) => invitation.status === 'SENT')).toBe(true);
    expect(await prisma.outboxMessage.count({ where: { template: 'invitation.sent' } })).toBe(5);
    expect(await prisma.job.count({ where: { status: 'FAILED' } })).toBe(0);
    expect(await prisma.job.count({ where: { status: 'DEAD' } })).toBe(0);
  });
});
