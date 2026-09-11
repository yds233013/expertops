import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { FixedClock, resetAmbientClock, setAmbientClock } from '@/lib/clock';
import { applyMigrations, newClient, truncateAll } from '../helpers/db';
import {
  actorFor,
  makeExpert,
  makeOperator,
  makeProject,
  makeStaffableExpert,
} from '../helpers/factories';
import {
  computeProjectGap,
  detectStaffingGaps,
  recommendReplacements,
  recordWithdrawal,
} from '@/server/services/staffing-gaps';
import { confirmAssignment, proposeAssignment } from '@/server/services/staffing';
import {
  createBatch,
  decideBatch,
  dispatchBatch,
  submitBatchForApproval,
} from '@/server/services/outreach';
import { listAttention, raiseAttention, resolveIfPresent } from '@/server/services/attention';
import { enqueueJob } from '@/server/services/jobs';
import { runMatching } from '@/server/services/matching';
import { Worker } from '@/server/worker/runner';

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

describe('staffing gap detection', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('counts everything already in flight before calling a project short', async () => {
    const operator = await makeOperator();
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 3 });

    const first = await makeStaffableExpert(project.id);
    const proposal = await proposeAssignment(prisma, actorFor(operator), {
      projectId: project.id,
      expertId: first.id,
      allocationHoursPerWeek: 10,
    });
    await confirmAssignment(prisma, actorFor(operator), proposal.id);

    // A second expert has accepted but is not staffed yet.
    await makeStaffableExpert(project.id);

    const gap = await computeProjectGap(prisma, project.id);
    expect(gap.seatsFilled).toBe(1);
    expect(gap.acceptedNotStaffed).toBe(1);
    expect(gap.gap).toBe(1); // 3 seats - 1 filled - 1 accepted
  });

  it('raises one attention item per short project and resolves it when filled', async () => {
    const operator = await makeOperator();
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 1 });

    const first = await detectStaffingGaps(prisma);
    expect(first.gapsFound).toBe(1);
    expect(first.attentionRaised).toBe(1);

    // Running it again refreshes rather than duplicating.
    const second = await detectStaffingGaps(prisma);
    expect(second.attentionRaised).toBe(0);
    expect(await prisma.attentionItem.count({ where: { category: 'staffing.gap' } })).toBe(1);

    // Fill the seat; the item resolves itself.
    const expert = await makeStaffableExpert(project.id);
    const proposal = await proposeAssignment(prisma, actorFor(operator), {
      projectId: project.id,
      expertId: expert.id,
      allocationHoursPerWeek: 10,
    });
    await confirmAssignment(prisma, actorFor(operator), proposal.id);

    const third = await detectStaffingGaps(prisma);
    expect(third.attentionResolved).toBeGreaterThanOrEqual(1);

    const open = await listAttention(prisma, { category: 'staffing.gap' });
    expect(open).toHaveLength(0);
  });

  it('says when a shortfall needs sourcing rather than chasing', async () => {
    const operator = await makeOperator();
    await makeProject(operator.id, { status: 'MATCHING', seatsRequested: 2 });

    await detectStaffingGaps(prisma);
    const items = await listAttention(prisma, { category: 'staffing.gap' });
    expect(items).toHaveLength(1);
    expect(items[0]!.nextAction).toContain('sourcing campaign');
    expect((items[0]!.metadata as Record<string, unknown>).needsSourcing).toBe(true);
  });

  it('names the specific blocker for an accepted expert who cannot be staffed', async () => {
    const operator = await makeOperator();
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 2 });
    const expert = await makeStaffableExpert(project.id);

    // Remove their availability so they become blocked.
    await prisma.availabilityWindow.deleteMany({ where: { expertId: expert.id } });

    await detectStaffingGaps(prisma);
    const blocked = await listAttention(prisma, { category: 'staffing.blocked_expert' });
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.blocker).toContain('No availability declared');
    expect(blocked[0]!.nextAction).toContain('portal');
  });
});

describe('withdrawal and replacement', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  async function staffedProject() {
    const operator = await makeOperator({ name: 'Sam Operator' });
    const approver = await makeOperator({ role: 'ADMIN', name: 'Dana Approver' });
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 2 });
    const expert = await makeStaffableExpert(project.id);
    const proposal = await proposeAssignment(prisma, actorFor(operator), {
      projectId: project.id,
      expertId: expert.id,
      allocationHoursPerWeek: 10,
    });
    const confirmed = await confirmAssignment(prisma, actorFor(operator), proposal.id);
    return { operator, approver, project, expert, assignment: confirmed.assignment };
  }

  it('releases the seat, withdraws the invitation and reopens the gap', async () => {
    const { operator, project, expert } = await staffedProject();
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).seatsFilled,
    ).toBe(1);

    const result = await recordWithdrawal(prisma, actorFor(operator), {
      projectId: project.id,
      expertId: expert.id,
      reason: 'Conflict at their day job.',
    });

    expect(result.releasedAssignmentId).not.toBeNull();
    expect(result.seatsFilled).toBe(0);
    expect(result.gap.gap).toBe(2);

    const invitation = await prisma.invitation.findUniqueOrThrow({
      where: { projectId_expertId: { projectId: project.id, expertId: expert.id } },
    });
    expect(invitation.status).toBe('WITHDRAWN');

    const items = await listAttention(prisma, { category: 'staffing.withdrawal' });
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe('HIGH');
    expect(items[0]!.blocker).toContain('Conflict at their day job');
  });

  it('requires a reason', async () => {
    const { operator, project, expert } = await staffedProject();
    await expectAppError(
      recordWithdrawal(prisma, actorFor(operator), {
        projectId: project.id,
        expertId: expert.id,
        reason: '   ',
      }),
      'BAD_REQUEST',
    );
  });

  it('recommends replacements without contacting anyone', async () => {
    const { operator, project, expert } = await staffedProject();

    // A pool to draw from.
    for (let index = 0; index < 3; index += 1) {
      await makeExpert({
        status: 'VERIFIED',
        skills: [{ name: 'Distributed Systems', proficiency: 4 }],
      });
    }
    await runMatching(prisma, actorFor(operator), project.id, { limit: 10 });

    await recordWithdrawal(prisma, actorFor(operator), {
      projectId: project.id,
      expertId: expert.id,
      reason: 'Withdrew.',
    });

    const recommendations = await recommendReplacements(prisma, project.id, 5);
    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations[0]!.rationale).toContain('Match score');
    // Nobody has been invited by producing recommendations.
    expect(
      await prisma.invitation.count({ where: { projectId: project.id, status: 'SENT' } }),
    ).toBe(0);
  });

  it('never excludes an already-invited expert from a replacement list', async () => {
    const { operator, project, expert } = await staffedProject();
    const other = await makeExpert({
      status: 'VERIFIED',
      skills: [{ name: 'Distributed Systems', proficiency: 4 }],
    });
    await runMatching(prisma, actorFor(operator), project.id, { limit: 10 });
    await recordWithdrawal(prisma, actorFor(operator), {
      projectId: project.id,
      expertId: expert.id,
      reason: 'Withdrew.',
    });

    const recommendations = await recommendReplacements(prisma, project.id, 5);
    const ids = recommendations.map((r) => r.expertId);
    expect(ids).toContain(other.id);
    // The person who withdrew is not suggested back.
    expect(ids).not.toContain(expert.id);
  });

  it('refuses to dispatch a replacement batch that nobody approved', async () => {
    const { operator, project } = await staffedProject();
    const candidateExpert = await makeExpert({ status: 'VERIFIED' });

    const batch = await createBatch(prisma, actorFor(operator), {
      kind: 'REPLACEMENT',
      projectId: project.id,
      reason: 'Seat vacated.',
      items: [{ expertId: candidateExpert.id, rationale: 'Next best match.' }],
    });

    await expectAppError(
      dispatchBatch(prisma, actorFor(operator), batch.id),
      'INVALID_STATE',
      /Only an APPROVED batch can be dispatched/,
    );
    expect(await prisma.invitation.count({ where: { projectId: project.id } })).toBe(1); // only the original
  });

  it('dispatches only after a human approves, and skips anyone now ineligible', async () => {
    const { operator, approver, project } = await staffedProject();
    const good = await makeExpert({ status: 'VERIFIED' });
    const archived = await makeExpert({ status: 'VERIFIED' });

    const batch = await createBatch(prisma, actorFor(operator), {
      kind: 'REPLACEMENT',
      projectId: project.id,
      reason: 'Seat vacated.',
      items: [{ expertId: good.id }, { expertId: archived.id }],
    });
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);
    await decideBatch(prisma, actorFor(approver), { batchId: batch.id, approve: true });

    // One recipient becomes ineligible between approval and dispatch.
    await prisma.expert.update({ where: { id: archived.id }, data: { status: 'ARCHIVED' } });

    const result = await dispatchBatch(prisma, actorFor(approver), batch.id);
    expect(result.dispatched).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain('archived');

    // The skip is recorded, not silently dropped.
    const skippedItem = await prisma.outreachBatchItem.findFirstOrThrow({
      where: { batchId: batch.id, expertId: archived.id },
    });
    expect(skippedItem.skippedReason).toContain('archived');
  });

  it('refuses self-approval of a large batch', async () => {
    const { operator, project } = await staffedProject();
    const items = [];
    for (let index = 0; index < 6; index += 1) {
      const expert = await makeExpert({ status: 'VERIFIED' });
      items.push({ expertId: expert.id });
    }

    const batch = await createBatch(prisma, actorFor(operator), {
      kind: 'REPLACEMENT',
      projectId: project.id,
      items,
    });
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);

    await expectAppError(
      decideBatch(prisma, actorFor(operator), { batchId: batch.id, approve: true }),
      'FORBIDDEN',
      /second operator/,
    );
  });

  it('requires a reason to reject a batch', async () => {
    const { operator, approver, project } = await staffedProject();
    const expert = await makeExpert({ status: 'VERIFIED' });
    const batch = await createBatch(prisma, actorFor(operator), {
      kind: 'REPLACEMENT',
      projectId: project.id,
      items: [{ expertId: expert.id }],
    });
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);

    await expectAppError(
      decideBatch(prisma, actorFor(approver), { batchId: batch.id, approve: false }),
      'BAD_REQUEST',
    );
  });

  it('lets only one operator decide a batch', async () => {
    const { operator, approver, project } = await staffedProject();
    const expert = await makeExpert({ status: 'VERIFIED' });
    const batch = await createBatch(prisma, actorFor(operator), {
      kind: 'REPLACEMENT',
      projectId: project.id,
      items: [{ expertId: expert.id }],
    });
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);

    const clients: PrismaClient[] = [newClient(), newClient()];
    try {
      const results = await Promise.allSettled([
        decideBatch(clients[0]!, actorFor(approver), { batchId: batch.id, approve: true }),
        decideBatch(clients[1]!, actorFor(approver), {
          batchId: batch.id,
          approve: false,
          note: 'No.',
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });
});

describe('the attention queue', () => {
  const clock = new FixedClock(new Date('2026-03-02T09:00:00Z'));

  beforeAll(() => applyMigrations());
  beforeEach(async () => {
    await truncateAll();
    clock.set(new Date('2026-03-02T09:00:00Z'));
    setAmbientClock(clock);
  });
  afterEach(() => resetAmbientClock());

  const sample = {
    dedupeKey: 'test:condition:1',
    category: 'test.category',
    title: 'Something is stuck',
    blocker: 'The thing did not happen.',
    impact: 'A person is waiting.',
    nextAction: 'Do the thing.',
  };

  it('never duplicates an alert for the same unresolved condition', async () => {
    for (let index = 0; index < 10; index += 1) {
      await raiseAttention(prisma, sample);
    }
    expect(await prisma.attentionItem.count({ where: { dedupeKey: sample.dedupeKey } })).toBe(1);
  });

  it('refreshes detail and lastSeenAt without creating a second item', async () => {
    const first = await raiseAttention(prisma, sample);
    expect(first.created).toBe(true);

    clock.advanceHours(1);
    const second = await raiseAttention(prisma, { ...sample, blocker: 'Updated detail.' });
    expect(second.created).toBe(false);
    expect(second.item.blocker).toBe('Updated detail.');
    expect(second.item.lastSeenAt.getTime()).toBeGreaterThan(first.item.lastSeenAt.getTime());
  });

  it('keeps an owner an operator already assigned', async () => {
    const operator = await makeOperator();
    await raiseAttention(prisma, sample);

    const { assignAttention } = await import('@/server/services/attention');
    const item = await prisma.attentionItem.findUniqueOrThrow({
      where: { dedupeKey: sample.dedupeKey },
    });
    await assignAttention(prisma, actorFor(operator), item.id, operator.id);

    await raiseAttention(prisma, sample);
    const after = await prisma.attentionItem.findUniqueOrThrow({
      where: { dedupeKey: sample.dedupeKey },
    });
    expect(after.ownerId).toBe(operator.id);
  });

  it('resolves silently when there is nothing open', async () => {
    expect(await resolveIfPresent(prisma, 'never:existed', 'nothing')).toBe(false);
  });

  it('reopens an item when the condition recurs', async () => {
    await raiseAttention(prisma, sample);
    await resolveIfPresent(prisma, sample.dedupeKey, 'fixed');
    expect(
      (await prisma.attentionItem.findUniqueOrThrow({ where: { dedupeKey: sample.dedupeKey } }))
        .status,
    ).toBe('RESOLVED');

    await raiseAttention(prisma, sample);
    const reopened = await prisma.attentionItem.findUniqueOrThrow({
      where: { dedupeKey: sample.dedupeKey },
    });
    expect(reopened.status).toBe('OPEN');
    expect(reopened.resolvedAt).toBeNull();
  });

  it('leaves a dismissed item dismissed until it resolves and recurs', async () => {
    const operator = await makeOperator();
    await raiseAttention(prisma, sample);
    const item = await prisma.attentionItem.findUniqueOrThrow({
      where: { dedupeKey: sample.dedupeKey },
    });

    const { dismissAttention } = await import('@/server/services/attention');
    await dismissAttention(prisma, actorFor(operator), item.id, 'Known and accepted.');

    await raiseAttention(prisma, sample);
    const after = await prisma.attentionItem.findUniqueOrThrow({
      where: { dedupeKey: sample.dedupeKey },
    });
    expect(after.status).toBe('DISMISSED');
  });

  it('requires a reason to dismiss', async () => {
    const operator = await makeOperator();
    await raiseAttention(prisma, sample);
    const item = await prisma.attentionItem.findUniqueOrThrow({
      where: { dedupeKey: sample.dedupeKey },
    });
    const { dismissAttention } = await import('@/server/services/attention');
    await expectAppError(
      dismissAttention(prisma, actorFor(operator), item.id, '  '),
      'BAD_REQUEST',
    );
  });

  it('separates automation failures from business blockers', async () => {
    await raiseAttention(prisma, sample);

    const { raiseAutomationFailure, attentionCounts } = await import('@/server/services/attention');
    await raiseAutomationFailure(prisma, {
      jobId: 'job-1',
      jobType: 'outbox.dispatch',
      error: 'boom',
      attempts: 5,
    });

    const counts = await attentionCounts(prisma);
    expect(counts.businessBlockers).toBe(1);
    expect(counts.automationFailures).toBe(1);

    const business = await listAttention(prisma, { kind: 'BUSINESS_BLOCKER' });
    const automation = await listAttention(prisma, { kind: 'AUTOMATION_FAILURE' });
    expect(business).toHaveLength(1);
    expect(automation).toHaveLength(1);
    // The two lists never overlap.
    expect(business[0]!.id).not.toBe(automation[0]!.id);
  });

  it('gives every item a blocker, an impact and a next action', async () => {
    const operator = await makeOperator();
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 2 });
    const expert = await makeStaffableExpert(project.id);
    await prisma.availabilityWindow.deleteMany({ where: { expertId: expert.id } });

    await detectStaffingGaps(prisma);
    const items = await listAttention(prisma, {});
    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      expect(item.blocker.length, `${item.title} has no blocker`).toBeGreaterThan(0);
      expect(item.impact.length, `${item.title} has no impact`).toBeGreaterThan(0);
      expect(item.nextAction.length, `${item.title} has no next action`).toBeGreaterThan(0);
      // Owner is either a person or explicitly nobody.
      expect(item.ownerId === null || typeof item.ownerId === 'string').toBe(true);
    }
  });

  it('does not duplicate items when several workers sweep at the same moment', async () => {
    const operator = await makeOperator();
    await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 3 });

    const clients: PrismaClient[] = [newClient(), newClient(), newClient()];
    try {
      const workers = clients.map(
        (client, index) => new Worker({ client, name: `sweeper-${index}`, batchSize: 10 }),
      );
      await workers[0]!.bootstrap();

      for (const worker of workers) {
        await enqueueJob(prisma, {
          type: 'attention.sweep',
          dedupeKey: `sweep-${worker.workerName}`,
        });
      }
      await Promise.all(workers.map((worker) => worker.tick(clock.now())));

      expect(await prisma.attentionItem.count({ where: { category: 'staffing.gap' } })).toBe(1);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });
});

describe('jobs are safe under duplicate delivery and stale state', () => {
  const clock = new FixedClock(new Date('2026-03-02T09:00:00Z'));

  beforeAll(() => applyMigrations());
  beforeEach(async () => {
    await truncateAll();
    clock.set(new Date('2026-03-02T09:00:00Z'));
    setAmbientClock(clock);
  });
  afterEach(() => resetAmbientClock());

  it('treats a job whose subject has moved on as a harmless skip, not a failure', async () => {
    const operator = await makeOperator();
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 1 });
    const expert = await makeStaffableExpert(project.id);
    const proposal = await proposeAssignment(prisma, actorFor(operator), {
      projectId: project.id,
      expertId: expert.id,
      allocationHoursPerWeek: 10,
    });
    const confirmed = await confirmAssignment(prisma, actorFor(operator), proposal.id);

    // The seat is released before the follow-up job runs.
    const { releaseAssignment } = await import('@/server/services/staffing');
    await releaseAssignment(prisma, actorFor(operator), confirmed.assignment.id, 'Changed plan.');

    await enqueueJob(prisma, {
      type: 'staffing.project_start_tasks',
      payload: { assignmentId: confirmed.assignment.id },
      dedupeKey: 'stale-start-tasks',
    });

    const worker = new Worker({ client: prisma, name: 'stale', batchSize: 5 });
    const summary = await worker.tick(clock.now());

    expect(summary.jobsFailed).toBe(0);
    expect(summary.jobsDead).toBe(0);

    const job = await prisma.job.findFirstOrThrow({ where: { dedupeKey: 'stale-start-tasks' } });
    expect(job.status).toBe('SUCCEEDED');
    expect((job.result as Record<string, unknown>).skipped).toContain('RELEASED');
  });

  it('skips a job whose subject was deleted', async () => {
    await enqueueJob(prisma, {
      type: 'payment.draft_from_approved_work',
      payload: { workItemId: 'gone' },
      dedupeKey: 'missing-work',
    });

    const worker = new Worker({ client: prisma, name: 'missing', batchSize: 5 });
    const summary = await worker.tick(clock.now());

    expect(summary.jobsSucceeded).toBe(1);
    const job = await prisma.job.findFirstOrThrow({ where: { dedupeKey: 'missing-work' } });
    expect((job.result as Record<string, unknown>).skipped).toContain('no longer exists');
  });

  it('produces the same outcome when the same event is delivered twice', async () => {
    const operator = await makeOperator();
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 1 });
    const expert = await makeStaffableExpert(project.id);
    const proposal = await proposeAssignment(prisma, actorFor(operator), {
      projectId: project.id,
      expertId: expert.id,
      allocationHoursPerWeek: 10,
    });
    const confirmed = await confirmAssignment(prisma, actorFor(operator), proposal.id);

    const worker = new Worker({ client: prisma, name: 'dupes', batchSize: 10 });
    await worker.tick(clock.now());

    // Deliver the same event again under a different key, as an at-least-once
    // queue would after a crash between run and acknowledge.
    await enqueueJob(prisma, {
      type: 'staffing.project_start_tasks',
      payload: { assignmentId: confirmed.assignment.id },
      dedupeKey: 'redelivered',
    });
    await worker.tick(clock.now());

    // One attention item, not two.
    expect(
      await prisma.attentionItem.count({ where: { category: 'delivery.no_work_assigned' } }),
    ).toBe(1);
  });
});
