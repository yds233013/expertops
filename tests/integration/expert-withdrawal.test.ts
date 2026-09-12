import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { FixedClock, resetAmbientClock, setAmbientClock } from '@/lib/clock';
import { applyMigrations, newClient, truncateAll } from '../helpers/db';
import {
  actorFor,
  actorForExpert,
  makeExpert,
  makeOperator,
  makeProject,
  makeStaffableExpert,
} from '../helpers/factories';
import { SYSTEM_ACTOR } from '@/server/services/activity';
import { listAttention } from '@/server/services/attention';
import { enqueueJob } from '@/server/services/jobs';
import { runMatching } from '@/server/services/matching';
import { dispatchBatch } from '@/server/services/outreach';
import { confirmAssignment, proposeAssignment } from '@/server/services/staffing';
import { recordWithdrawal, listExpertCommitments } from '@/server/services/staffing-gaps';
import { createWorkItem, reviewWork, submitWork } from '@/server/services/work';
import { Worker } from '@/server/worker/runner';

/**
 * Expert-initiated withdrawal, against a real PostgreSQL instance.
 *
 * The properties under test are the ones a portal button makes reachable by
 * anyone: a withdrawal must be scoped to the expert's own commitment, must not
 * double its effects when the request arrives twice, and must not take earned
 * work or prepared payment with it.
 */
const extraClients: PrismaClient[] = [];

function extraClient(): PrismaClient {
  const client = newClient();
  extraClients.push(client);
  return client;
}

async function expectAppError(promise: Promise<unknown>, code: string, pattern?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(error, `expected an AppError, got ${String(error)}`).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    if (pattern) expect((error as AppError).message).toMatch(pattern);
    return error as AppError;
  }
  throw new Error(`expected the call to reject with ${code}`);
}

function withdrawalCount(projectId: string, expertId: string) {
  return prisma.activityEvent.count({
    where: { projectId, expertId, action: 'assignment.expert_withdrew' },
  });
}

function replacementJobCount(projectId: string) {
  return prisma.job.count({
    where: { type: 'staffing.propose_replacements', dedupeKey: { contains: projectId } },
  });
}

/** An accepted invitation and nothing more: the pre-assignment case. */
async function acceptedOnly(seatsRequested = 2) {
  const operator = await makeOperator({ name: 'Sam Operator' });
  const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested });
  const expert = await makeStaffableExpert(project.id);
  return { operator, project, expert };
}

/** A confirmed seat: the post-assignment case. */
async function staffed(seatsRequested = 2) {
  const base = await acceptedOnly(seatsRequested);
  const proposal = await proposeAssignment(prisma, actorFor(base.operator), {
    projectId: base.project.id,
    expertId: base.expert.id,
    allocationHoursPerWeek: 10,
  });
  const confirmed = await confirmAssignment(prisma, actorFor(base.operator), proposal.id);
  return { ...base, assignment: confirmed.assignment };
}

describe('expert withdrawal: before assignment', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());
  afterAll(async () => {
    await Promise.all(extraClients.map((client) => client.$disconnect()));
    extraClients.length = 0;
  });

  it('withdraws an accepted invitation with no seat to release', async () => {
    const { project, expert } = await acceptedOnly();

    const result = await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: project.id,
      expertId: expert.id,
      reason: 'A client deadline moved onto the same weeks.',
    });

    expect(result.alreadyWithdrawn).toBe(false);
    // Nothing was assigned, so nothing was released.
    expect(result.releasedAssignmentId).toBeNull();
    expect(result.cancelledWorkItemIds).toEqual([]);

    const invitation = await prisma.invitation.findUniqueOrThrow({
      where: { projectId_expertId: { projectId: project.id, expertId: expert.id } },
    });
    expect(invitation.status).toBe('WITHDRAWN');
    expect(invitation.withdrawReason).toContain('A client deadline moved');

    // The expert's own view of it says withdrawn, not merely absent.
    const commitments = await listExpertCommitments(prisma, expert.id);
    expect(commitments.active).toHaveLength(0);
    expect(commitments.withdrawn.map((row) => row.projectCode)).toEqual([project.code]);

    const items = await listAttention(prisma, { category: 'staffing.withdrawal' });
    expect(items).toHaveLength(1);
    expect(items[0]!.expertId).toBe(expert.id);
    expect(await replacementJobCount(project.id)).toBe(1);
  });

  it('records the withdrawal against the expert as the actor', async () => {
    const { project, expert } = await acceptedOnly();

    await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: project.id,
      expertId: expert.id,
    });

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { action: 'assignment.expert_withdrew' },
    });
    expect(event.actorType).toBe('EXPERT');
    expect(event.actorExpertId).toBe(expert.id);
    expect(event.actorUserId).toBeNull();
  });
});

describe('expert withdrawal: after assignment', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('releases the seat and gives the capacity back to the project', async () => {
    const { project, expert, assignment } = await staffed();
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).seatsFilled,
    ).toBe(1);

    const result = await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: project.id,
      expertId: expert.id,
      reason: 'Illness.',
    });

    expect(result.releasedAssignmentId).toBe(assignment.id);
    expect(result.seatsFilled).toBe(0);
    expect(result.gap.gap).toBe(2);

    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.seatsFilled).toBe(0);

    const released = await prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(released.status).toBe('RELEASED');
    expect(released.confirmedAt).toBeNull();
    expect(released.releaseReason).toContain('Illness');
  });

  it('releases only the commitment on the project withdrawn from', async () => {
    const operator = await makeOperator();
    const projectOne = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 2 });
    const projectTwo = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 2 });

    // One expert, two seats. Reuse the same expert on the second project by
    // giving them the invitation and availability that project needs.
    const expert = await makeStaffableExpert(projectOne.id);
    await prisma.invitation.create({
      data: {
        projectId: projectTwo.id,
        expertId: expert.id,
        status: 'ACCEPTED',
        expiresAt: new Date(Date.now() + 86_400_000),
        sentAt: new Date(),
        respondedAt: new Date(),
      },
    });
    await prisma.availabilityWindow.create({
      data: {
        expertId: expert.id,
        projectId: projectTwo.id,
        startAt: new Date(Date.now() - 86_400_000),
        endAt: new Date(Date.now() + 60 * 86_400_000),
        hoursPerWeek: 20,
      },
    });

    const first = await proposeAssignment(prisma, actorFor(operator), {
      projectId: projectOne.id,
      expertId: expert.id,
      allocationHoursPerWeek: 10,
    });
    await confirmAssignment(prisma, actorFor(operator), first.id);
    const second = await proposeAssignment(prisma, actorFor(operator), {
      projectId: projectTwo.id,
      expertId: expert.id,
      allocationHoursPerWeek: 5,
    });
    await confirmAssignment(prisma, actorFor(operator), second.id);

    await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: projectOne.id,
      expertId: expert.id,
      reason: 'Too much on.',
    });

    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
      'RELEASED',
    );
    // The other seat is untouched, including its capacity accounting.
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: second.id } })).status).toBe(
      'CONFIRMED',
    );
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: projectTwo.id } })).seatsFilled,
    ).toBe(1);
    expect(
      (
        await prisma.invitation.findUniqueOrThrow({
          where: { projectId_expertId: { projectId: projectTwo.id, expertId: expert.id } },
        })
      ).status,
    ).toBe('ACCEPTED');
  });
});

describe('expert withdrawal: repeated and concurrent requests', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());
  afterAll(async () => {
    await Promise.all(extraClients.map((client) => client.$disconnect()));
    extraClients.length = 0;
  });

  it('produces one set of effects however many times it is clicked', async () => {
    const { project, expert } = await staffed();

    const first = await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: project.id,
      expertId: expert.id,
      reason: 'Changed circumstances.',
    });
    expect(first.alreadyWithdrawn).toBe(false);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = await recordWithdrawal(prisma, actorForExpert(expert), {
        projectId: project.id,
        expertId: expert.id,
        reason: 'Changed circumstances.',
      });
      expect(again.alreadyWithdrawn).toBe(true);
      expect(again.releasedAssignmentId).toBe(first.releasedAssignmentId);
    }

    expect(await withdrawalCount(project.id, expert.id)).toBe(1);
    expect(await prisma.attentionItem.count({ where: { category: 'staffing.withdrawal' } })).toBe(
      1,
    );
    expect(await replacementJobCount(project.id)).toBe(1);
    // The seat was released once, not released and then re-released.
    expect(await prisma.activityEvent.count({ where: { action: 'assignment.released' } })).toBe(1);
  });

  it('does not reopen an attention item an operator already resolved', async () => {
    const { project, expert } = await staffed();
    await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: project.id,
      expertId: expert.id,
    });

    const key = `staffing:withdrawal:${project.id}:${expert.id}`;
    await prisma.attentionItem.update({
      where: { dedupeKey: key },
      data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedReason: 'Handled.' },
    });

    await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: project.id,
      expertId: expert.id,
    });

    const item = await prisma.attentionItem.findUniqueOrThrow({ where: { dedupeKey: key } });
    expect(item.status).toBe('RESOLVED');
  });

  it('serialises two simultaneous withdrawals into a single effect', async () => {
    const { project, expert } = await staffed();

    // Two connections, so the race is real at the database level rather than
    // interleaved inside one pool slot.
    const clientOne = extraClient();
    const clientTwo = extraClient();

    const results = await Promise.allSettled([
      recordWithdrawal(clientOne, actorForExpert(expert), {
        projectId: project.id,
        expertId: expert.id,
        reason: 'Double submit.',
      }),
      recordWithdrawal(clientTwo, actorForExpert(expert), {
        projectId: project.id,
        expertId: expert.id,
        reason: 'Double submit.',
      }),
    ]);

    // Neither request fails: the loser reports the withdrawal that already
    // happened. What must not happen is two of anything.
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const fulfilled = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    expect(fulfilled.filter((value) => value.alreadyWithdrawn === false)).toHaveLength(1);

    expect(await withdrawalCount(project.id, expert.id)).toBe(1);
    expect(await prisma.attentionItem.count({ where: { category: 'staffing.withdrawal' } })).toBe(
      1,
    );
    expect(await replacementJobCount(project.id)).toBe(1);
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).seatsFilled,
    ).toBe(0);
  });
});

describe('expert withdrawal: scope', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('refuses a project the expert has no commitment on, and changes nothing', async () => {
    const { operator, expert } = await staffed();
    const other = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 2 });

    await expectAppError(
      recordWithdrawal(prisma, actorForExpert(expert), {
        projectId: other.id,
        expertId: expert.id,
      }),
      'INVALID_STATE',
      /nothing to withdraw from/,
    );

    expect(await withdrawalCount(other.id, expert.id)).toBe(0);
    expect(await prisma.attentionItem.count({ where: { projectId: other.id } })).toBe(0);
    expect(await replacementJobCount(other.id)).toBe(0);
  });

  it("refuses to withdraw another expert's commitment", async () => {
    const { project } = await staffed();
    const stranger = await makeExpert({ status: 'VERIFIED' });

    await expectAppError(
      recordWithdrawal(prisma, actorForExpert(stranger), {
        projectId: project.id,
        expertId: stranger.id,
      }),
      'INVALID_STATE',
      /nothing to withdraw from/,
    );

    // The expert who actually holds the seat still holds it.
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).seatsFilled,
    ).toBe(1);
    expect(
      await prisma.activityEvent.count({ where: { action: 'assignment.expert_withdrew' } }),
    ).toBe(0);
  });

  it('refuses an unknown project and an unknown expert', async () => {
    const { project, expert } = await staffed();

    await expectAppError(
      recordWithdrawal(prisma, actorForExpert(expert), {
        projectId: 'does-not-exist',
        expertId: expert.id,
      }),
      'NOT_FOUND',
    );
    await expectAppError(
      recordWithdrawal(prisma, SYSTEM_ACTOR, {
        projectId: project.id,
        expertId: 'does-not-exist',
      }),
      'NOT_FOUND',
    );
  });

  it('refuses a second withdrawal after the expert was released by an operator', async () => {
    const { operator, project, expert, assignment } = await staffed();
    const { releaseAssignment } = await import('@/server/services/staffing');
    await releaseAssignment(prisma, actorFor(operator), assignment.id, 'Operator released.');

    // The invitation is still ACCEPTED, so this is a legitimate withdrawal of
    // the acceptance even though the seat is already gone.
    const result = await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: project.id,
      expertId: expert.id,
    });
    expect(result.alreadyWithdrawn).toBe(false);
    expect(result.releasedAssignmentId).toBeNull();

    const second = await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: project.id,
      expertId: expert.id,
    });
    expect(second.alreadyWithdrawn).toBe(true);
    expect(await withdrawalCount(project.id, expert.id)).toBe(1);
  });
});

describe('expert withdrawal: reminders and delivery records', () => {
  const clock = new FixedClock(new Date('2026-04-01T09:00:00Z'));

  beforeAll(() => applyMigrations());
  beforeEach(async () => {
    await truncateAll();
    clock.set(new Date('2026-04-01T09:00:00Z'));
    setAmbientClock(clock);
  });
  afterEach(() => resetAmbientClock());

  async function runQueue(now: Date) {
    const worker = new Worker({ client: prisma, name: 'withdrawal-test', batchSize: 10 });
    // Two passes: one for the job enqueued by the test, one for anything that
    // job enqueued in turn. No sleeping — the queue is drained explicitly.
    await worker.tick(now);
    await worker.tick(now);
  }

  it('stops the overdue reminder for work the expert can no longer deliver', async () => {
    const { operator, project, expert, assignment } = await staffed();

    const workItem = await createWorkItem(prisma, actorFor(operator), {
      assignmentId: assignment.id,
      title: 'Draft the threat model',
      dueAt: new Date('2026-03-25T09:00:00Z'),
    });

    await enqueueJob(prisma, { type: 'work.remind_overdue', payload: {} });
    await runQueue(clock.now());

    const reminder = await prisma.attentionItem.findUnique({
      where: { dedupeKey: `work:overdue:${workItem.id}` },
    });
    expect(reminder?.status).toBe('OPEN');

    const result = await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: project.id,
      expertId: expert.id,
      reason: 'No longer able to deliver.',
    });
    expect(result.cancelledWorkItemIds).toEqual([workItem.id]);

    // The reminder is closed at withdrawal time, not at the next sweep.
    const closed = await prisma.attentionItem.findUniqueOrThrow({
      where: { dedupeKey: `work:overdue:${workItem.id}` },
    });
    expect(closed.status).toBe('RESOLVED');
    expect(closed.resolvedReason).toContain('cancelled');

    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: workItem.id } })).status).toBe(
      'CANCELLED',
    );

    // And it does not come back on the next run.
    clock.advanceHours(1);
    await enqueueJob(prisma, { type: 'work.remind_overdue', payload: {} });
    await runQueue(clock.now());
    const after = await prisma.attentionItem.findUniqueOrThrow({
      where: { dedupeKey: `work:overdue:${workItem.id}` },
    });
    expect(after.status).toBe('RESOLVED');
  });

  it('keeps approved work and its prepared payment', async () => {
    const { operator, project, expert, assignment } = await staffed();

    const done = await createWorkItem(prisma, actorFor(operator), {
      assignmentId: assignment.id,
      title: 'Completed review note',
      basis: 'HOURLY',
    });
    await submitWork(prisma, actorForExpert(expert), {
      workItemId: done.id,
      content: 'The finished note.',
      hoursClaimed: '4',
    });
    await reviewWork(prisma, actorFor(operator), {
      workItemId: done.id,
      approve: true,
      summary: 'Good.',
    });

    // Let payment preparation run, so there is a payment record to protect.
    await runQueue(clock.now());
    const payment = await prisma.paymentItem.findFirstOrThrow({ where: { workItemId: done.id } });

    const outstanding = await createWorkItem(prisma, actorFor(operator), {
      assignmentId: assignment.id,
      title: 'Not started yet',
    });
    const submittedButUnreviewed = await createWorkItem(prisma, actorFor(operator), {
      assignmentId: assignment.id,
      title: 'Waiting on review',
    });
    await submitWork(prisma, actorForExpert(expert), {
      workItemId: submittedButUnreviewed.id,
      content: 'Handed in before leaving.',
    });

    const result = await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: project.id,
      expertId: expert.id,
      reason: 'Leaving.',
    });

    // Only the item still waiting on the expert is cancelled.
    expect(result.cancelledWorkItemIds).toEqual([outstanding.id]);
    expect(
      (await prisma.workItem.findUniqueOrThrow({ where: { id: outstanding.id } })).status,
    ).toBe('CANCELLED');
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: done.id } })).status).toBe(
      'APPROVED',
    );
    expect(
      (await prisma.workItem.findUniqueOrThrow({ where: { id: submittedButUnreviewed.id } }))
        .status,
    ).toBe('SUBMITTED');

    // The payment record is untouched, not cancelled and not deleted.
    const afterPayment = await prisma.paymentItem.findUniqueOrThrow({ where: { id: payment.id } });
    expect(afterPayment.status).toBe(payment.status);
    expect(afterPayment.amountMinor).toBe(payment.amountMinor);

    // The submissions the expert made survive their departure.
    expect(await prisma.workSubmission.count()).toBe(2);
  });
});

describe('expert withdrawal: the replacement path', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('raises a staffing shortage and proposes a replacement batch that needs approval', async () => {
    const { operator, project, expert } = await staffed(2);

    for (let index = 0; index < 3; index += 1) {
      await makeExpert({
        status: 'VERIFIED',
        skills: [{ name: 'Distributed Systems', proficiency: 4 }],
      });
    }
    await runMatching(prisma, actorFor(operator), project.id, { limit: 10 });

    await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: project.id,
      expertId: expert.id,
      reason: 'Stepping away.',
    });

    const attention = await listAttention(prisma, { category: 'staffing.withdrawal' });
    expect(attention).toHaveLength(1);
    expect(attention[0]!.severity).toBe('HIGH');
    expect(attention[0]!.nextAction).toContain('approved outreach batch');

    const worker = new Worker({ client: prisma, name: 'replacements', batchSize: 10 });
    await worker.tick(new Date());
    await worker.tick(new Date());

    const batch = await prisma.outreachBatch.findFirstOrThrow({
      where: { projectId: project.id, kind: 'REPLACEMENT' },
      include: { items: true },
    });
    expect(batch.items.length).toBeGreaterThan(0);
    expect(['DRAFT', 'PENDING_APPROVAL']).toContain(batch.status);
    expect(batch.approvedById).toBeNull();

    // Nothing was sent by proposing it.
    expect(
      await prisma.invitation.count({ where: { projectId: project.id, status: 'SENT' } }),
    ).toBe(0);
    expect(
      await prisma.attentionItem.count({ where: { category: 'outreach.awaiting_approval' } }),
    ).toBeGreaterThanOrEqual(0);

    // And it cannot be dispatched without an approval.
    await expectAppError(
      dispatchBatch(prisma, actorFor(operator), batch.id),
      'INVALID_STATE',
      /Only an approved batch can be dispatched/,
    );
    expect(
      await prisma.invitation.count({ where: { projectId: project.id, status: 'SENT' } }),
    ).toBe(0);
  });

  it('reopens a fully staffed project so a replacement can be invited at all', async () => {
    // One seat, confirmed, which is what turns a project ACTIVE.
    const { operator, project, expert } = await staffed(1);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe(
      'ACTIVE',
    );

    await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: project.id,
      expertId: expert.id,
      reason: 'Leaving.',
    });

    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.status).toBe('STAFFING');

    // The point of reopening it: an ACTIVE project refuses invitations, so
    // without this the replacement batch could never be dispatched.
    const replacement = await makeExpert({ status: 'VERIFIED' });
    const { createInvitation } = await import('@/server/services/invitations');
    const invitation = await createInvitation(prisma, actorFor(operator), {
      projectId: project.id,
      expertId: replacement.id,
    });
    expect(invitation.status).toBe('DRAFT');
  });

  it('does not queue a second replacement search for a repeated withdrawal', async () => {
    const { project, expert } = await staffed(2);

    await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: project.id,
      expertId: expert.id,
    });
    await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: project.id,
      expertId: expert.id,
    });

    expect(await replacementJobCount(project.id)).toBe(1);
  });
});
