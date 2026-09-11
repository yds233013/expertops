import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { applyMigrations, newClient, truncateAll } from '../helpers/db';
import {
  actorFor,
  makeConfirmedAssignment,
  makeExpert,
  makeOperator,
  makeProject,
} from '../helpers/factories';
import {
  createWorkItem,
  listWorkItemsForExpert,
  reviewWork,
  submitWork,
} from '@/server/services/work';
import {
  approveBatch,
  correctPaymentItem,
  createBatch,
  draftPaymentFromApprovedWork,
  exportBatch,
  resolveDiscrepancy,
  submitBatchForApproval,
} from '@/server/services/payments';
import {
  listSupportForExpert,
  raiseSupportRequest,
  replyToSupport,
  resolveSupport,
  setBlocking,
} from '@/server/services/support';
import { readinessBlocker } from '@/server/services/staffing-gaps';
import { confirmTask, openOffboarding } from '@/server/services/offboarding';

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

async function deliveryFixture(options: { rateCents?: number; ceiling?: number | null } = {}) {
  const operator = await makeOperator({ name: 'Sam Operator' });
  const approver = await makeOperator({ role: 'ADMIN', name: 'Dana Approver' });
  const project = await makeProject(operator.id, {
    status: 'ACTIVE',
    seatsRequested: 2,
    maxHourlyRateCents: options.ceiling === undefined ? 30_000 : options.ceiling,
  });
  const expert = await makeExpert({
    status: 'VERIFIED',
    hourlyRateCents: options.rateCents ?? 20_000,
  });
  const assignment = await makeConfirmedAssignment(project.id, expert.id, {
    rateCents: options.rateCents ?? 20_000,
  });
  return { operator, approver, project, expert, assignment, actor: actorFor(operator) };
}

describe('work items and reviews', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('refuses to assign work on a seat that is not confirmed', async () => {
    const operator = await makeOperator();
    const project = await makeProject(operator.id, { status: 'STAFFING' });
    const expert = await makeExpert({ status: 'VERIFIED' });
    const proposed = await prisma.assignment.create({
      data: { projectId: project.id, expertId: expert.id, status: 'PROPOSED', rateCents: 20_000 },
    });

    await expectAppError(
      createWorkItem(prisma, actorFor(operator), {
        assignmentId: proposed.id,
        title: 'Too early',
      }),
      'INVALID_STATE',
      /confirmed seat/,
    );
  });

  it('runs submit, revision, resubmit, approve and records each revision', async () => {
    const { assignment, expert, actor } = await deliveryFixture();
    const workItem = await createWorkItem(prisma, actor, {
      assignmentId: assignment.id,
      title: 'Timeline',
      basis: 'HOURLY',
    });

    const expertActor = { type: 'EXPERT' as const, expertId: expert.id, label: expert.fullName };

    await submitWork(prisma, expertActor, {
      workItemId: workItem.id,
      content: 'First pass.',
      hoursClaimed: '10.00',
    });

    await reviewWork(prisma, actor, {
      workItemId: workItem.id,
      approve: false,
      revisionRequest: 'Missing the exfiltration stage.',
      feedback: { completeness: 'Incomplete.' },
    });

    const second = await submitWork(prisma, expertActor, {
      workItemId: workItem.id,
      content: 'Second pass with exfiltration.',
      hoursClaimed: '14.00',
    });
    expect(second.revision).toBe(2);

    const approved = await reviewWork(prisma, actor, {
      workItemId: workItem.id,
      approve: true,
      approvedQuantity: '13.50',
      feedback: { accuracy: 'Good.' },
    });
    expect(approved.review.state).toBe('APPROVED');

    const stored = await prisma.workItem.findUniqueOrThrow({ where: { id: workItem.id } });
    expect(stored.status).toBe('APPROVED');
    expect(stored.approvedQuantity?.toString()).toBe('13.5');

    // Both revisions survive.
    expect(await prisma.workSubmission.count({ where: { workItemId: workItem.id } })).toBe(2);
    expect(await prisma.workReview.count({ where: { workItemId: workItem.id } })).toBe(2);
  });

  it('requires hours on an hourly item and a specific revision request', async () => {
    const { assignment, expert, actor } = await deliveryFixture();
    const workItem = await createWorkItem(prisma, actor, {
      assignmentId: assignment.id,
      title: 'Timeline',
      basis: 'HOURLY',
    });
    const expertActor = { type: 'EXPERT' as const, expertId: expert.id, label: expert.fullName };

    await expectAppError(
      submitWork(prisma, expertActor, { workItemId: workItem.id, content: 'No hours.' }),
      'BAD_REQUEST',
      /hours worked must be supplied/,
    );

    await submitWork(prisma, expertActor, {
      workItemId: workItem.id,
      content: 'With hours.',
      hoursClaimed: '5',
    });

    await expectAppError(
      reviewWork(prisma, actor, { workItemId: workItem.id, approve: false }),
      'BAD_REQUEST',
      /specific description/,
    );
  });

  it('rejects an unknown feedback dimension', async () => {
    const { assignment, expert, actor } = await deliveryFixture();
    const workItem = await createWorkItem(prisma, actor, {
      assignmentId: assignment.id,
      title: 'Timeline',
    });
    await submitWork(
      prisma,
      { type: 'EXPERT', expertId: expert.id, label: expert.fullName },
      { workItemId: workItem.id, content: 'Done.' },
    );

    await expectAppError(
      reviewWork(prisma, actor, {
        workItemId: workItem.id,
        approve: true,
        feedback: { attitude: 'Poor' },
      }),
      'BAD_REQUEST',
      /Unknown feedback dimension/,
    );
  });

  it('does not change any expert-wide standing from a single review', async () => {
    const { assignment, expert, actor } = await deliveryFixture();
    const before = await prisma.expert.findUniqueOrThrow({ where: { id: expert.id } });

    const workItem = await createWorkItem(prisma, actor, {
      assignmentId: assignment.id,
      title: 'Timeline',
    });
    await submitWork(
      prisma,
      { type: 'EXPERT', expertId: expert.id, label: expert.fullName },
      { workItemId: workItem.id, content: 'Weak work.' },
    );
    await reviewWork(prisma, actor, {
      workItemId: workItem.id,
      approve: false,
      revisionRequest: 'Substantially rework this.',
    });

    const after = await prisma.expert.findUniqueOrThrow({ where: { id: expert.id } });
    expect(after.status).toBe(before.status);
    expect(after.hourlyRateCents).toBe(before.hourlyRateCents);
    expect(after.yearsExperience).toBe(before.yearsExperience);

    // And the activity record says so explicitly.
    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { action: 'work.revision_requested' },
    });
    expect((event.metadata as Record<string, unknown>).affectsExpertRanking).toBe(false);
  });

  it("hides another expert's work from the portal view", async () => {
    const first = await deliveryFixture();
    const second = await deliveryFixture();

    const workItem = await createWorkItem(prisma, first.actor, {
      assignmentId: first.assignment.id,
      title: 'First expert work',
    });

    // The other expert cannot see it.
    const visible = await listWorkItemsForExpert(prisma, second.expert.id);
    expect(visible.map((item) => item.id)).not.toContain(workItem.id);

    // And cannot submit against it.
    await expectAppError(
      submitWork(
        prisma,
        { type: 'EXPERT', expertId: second.expert.id, label: second.expert.fullName },
        { workItemId: workItem.id, content: 'Not mine.' },
      ),
      'NOT_FOUND',
    );
  });

  it('omits reviewer identity from the expert-facing view', async () => {
    const { assignment, expert, actor, operator } = await deliveryFixture();
    const workItem = await createWorkItem(prisma, actor, {
      assignmentId: assignment.id,
      title: 'Timeline',
    });
    await submitWork(
      prisma,
      { type: 'EXPERT', expertId: expert.id, label: expert.fullName },
      { workItemId: workItem.id, content: 'Done.' },
    );
    await reviewWork(prisma, actor, {
      workItemId: workItem.id,
      approve: true,
      summary: 'Looks right.',
    });

    const view = await listWorkItemsForExpert(prisma, expert.id);
    const serialised = JSON.stringify(view);
    expect(serialised).toContain('Looks right.');
    expect(serialised).not.toContain(operator.name);
    expect(serialised).not.toContain('reviewerId');
  });
});

describe('payment preparation', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  async function approvedWork(
    options: { claimed?: string; approved?: string; rateCents?: number } = {},
  ) {
    const fixture = await deliveryFixture({ rateCents: options.rateCents });
    const workItem = await createWorkItem(prisma, fixture.actor, {
      assignmentId: fixture.assignment.id,
      title: 'Timeline',
      basis: 'HOURLY',
    });
    await submitWork(
      prisma,
      { type: 'EXPERT', expertId: fixture.expert.id, label: fixture.expert.fullName },
      { workItemId: workItem.id, content: 'Done.', hoursClaimed: options.claimed ?? '10.00' },
    );
    await reviewWork(prisma, fixture.actor, {
      workItemId: workItem.id,
      approve: true,
      approvedQuantity: options.approved ?? options.claimed ?? '10.00',
    });
    return { ...fixture, workItem };
  }

  it('drafts exactly one payment item however many times the job runs', async () => {
    const { workItem, actor } = await approvedWork();

    const first = await draftPaymentFromApprovedWork(prisma, actor, { workItemId: workItem.id });
    const second = await draftPaymentFromApprovedWork(prisma, actor, { workItemId: workItem.id });
    const third = await draftPaymentFromApprovedWork(prisma, actor, { workItemId: workItem.id });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(await prisma.paymentItem.count({ where: { workItemId: workItem.id } })).toBe(1);
  });

  it('drafts once even when two workers race', async () => {
    const { workItem, actor } = await approvedWork();
    const clientOne = newClient();
    const clientTwo = newClient();
    try {
      const results = await Promise.allSettled([
        draftPaymentFromApprovedWork(clientOne, actor, { workItemId: workItem.id }),
        draftPaymentFromApprovedWork(clientTwo, actor, { workItemId: workItem.id }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(await prisma.paymentItem.count({ where: { workItemId: workItem.id } })).toBe(1);
    } finally {
      await Promise.all([clientOne.$disconnect(), clientTwo.$disconnect()]);
    }
  });

  it('computes the amount with exact integer arithmetic', async () => {
    // 13.33 hours at 245.55/hour.
    // 1333 x 24555 = 32,731,815 hundredth-cents -> 327,318.15 cents -> 327,318.
    const { workItem, actor } = await approvedWork({
      claimed: '13.33',
      approved: '13.33',
      rateCents: 24_555,
    });
    const { item } = await draftPaymentFromApprovedWork(prisma, actor, { workItemId: workItem.id });
    expect(item.rateMinor).toBe(24_555);
    expect(item.quantity.toString()).toBe('13.33');
    expect(item.amountMinor).toBe(327_318);

    // The naive floating-point calculation gets this wrong; we do not.
    expect(item.amountMinor).not.toBe(Math.round(13.33 * 24_555 * 100) / 100);
  });

  it('flags an adjusted quantity and blocks batching until it is explained', async () => {
    const { workItem, actor, operator, approver } = await approvedWork({
      claimed: '16.00',
      approved: '14.50',
    });
    const { item, discrepancies } = await draftPaymentFromApprovedWork(prisma, actor, {
      workItemId: workItem.id,
    });

    expect(item.status).toBe('DRAFT');
    expect(discrepancies.map((d) => d.code)).toContain('QUANTITY_ADJUSTED');

    await expectAppError(
      createBatch(prisma, actorFor(operator), {
        periodStart: new Date('2026-05-01'),
        periodEnd: new Date('2026-05-31'),
        itemIds: [item.id],
      }),
      'INVALID_STATE',
      /unresolved discrepancies/,
    );

    await expectAppError(
      resolveDiscrepancy(prisma, actor, { paymentItemId: item.id, resolution: '  ' }),
      'BAD_REQUEST',
    );

    const cleared = await resolveDiscrepancy(prisma, actor, {
      paymentItemId: item.id,
      resolution: 'Reviewer disallowed setup time; agreed with the expert.',
    });
    expect(cleared.status).toBe('READY');

    const batch = await createBatch(prisma, actorFor(operator), {
      periodStart: new Date('2026-05-01'),
      periodEnd: new Date('2026-05-31'),
      itemIds: [item.id],
    });
    expect(batch.itemCount).toBe(1);
    void approver;
  });

  it('refuses to put the same approved work in two active batches', async () => {
    const { workItem, actor, operator } = await approvedWork();
    const { item } = await draftPaymentFromApprovedWork(prisma, actor, { workItemId: workItem.id });

    const first = await createBatch(prisma, actorFor(operator), {
      periodStart: new Date('2026-05-01'),
      periodEnd: new Date('2026-05-31'),
      itemIds: [item.id],
    });

    await expectAppError(
      createBatch(prisma, actorFor(operator), {
        periodStart: new Date('2026-06-01'),
        periodEnd: new Date('2026-06-30'),
        itemIds: [item.id],
      }),
      'CONFLICT',
      new RegExp(first.reference),
    );
  });

  it('refuses approval by the operator who created the batch', async () => {
    const { workItem, actor, operator } = await approvedWork();
    const { item } = await draftPaymentFromApprovedWork(prisma, actor, { workItemId: workItem.id });
    const batch = await createBatch(prisma, actorFor(operator), {
      periodStart: new Date('2026-05-01'),
      periodEnd: new Date('2026-05-31'),
      itemIds: [item.id],
    });
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);

    await expectAppError(
      approveBatch(prisma, actorFor(operator), { batchId: batch.id }),
      'FORBIDDEN',
      /other than the operator who created it/,
    );
  });

  it('refuses to export a batch that has not been approved', async () => {
    const { workItem, actor, operator } = await approvedWork();
    const { item } = await draftPaymentFromApprovedWork(prisma, actor, { workItemId: workItem.id });
    const batch = await createBatch(prisma, actorFor(operator), {
      periodStart: new Date('2026-05-01'),
      periodEnd: new Date('2026-05-31'),
      itemIds: [item.id],
    });

    await expectAppError(
      exportBatch(prisma, actorFor(operator), batch.id),
      'INVALID_STATE',
      /Only an APPROVED batch can be exported/,
    );
  });

  it('exports approved work and records that exported is not paid', async () => {
    const { workItem, actor, operator, approver } = await approvedWork();
    const { item } = await draftPaymentFromApprovedWork(prisma, actor, { workItemId: workItem.id });
    const batch = await createBatch(prisma, actorFor(operator), {
      periodStart: new Date('2026-05-01'),
      periodEnd: new Date('2026-05-31'),
      itemIds: [item.id],
    });
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);
    await approveBatch(prisma, actorFor(approver), { batchId: batch.id });

    const exported = await exportBatch(prisma, actorFor(approver), batch.id);
    expect(exported.csv).toContain('payment_reference');
    expect(exported.csv).toContain(item.reference);
    expect(exported.filename).toMatch(/\.csv$/);

    const stored = await prisma.paymentBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(stored.status).toBe('EXPORTED');
    expect(stored.exportedAt).not.toBeNull();

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { action: 'payment.batch_exported' },
    });
    expect((event.metadata as Record<string, unknown>).meaning).toBe(
      'exported-for-finance-not-paid',
    );

    // There is no status that means "paid".
    const statuses = Object.values(
      await prisma.paymentItem.findMany({ select: { status: true } }),
    ).map((row) => row.status);
    expect(statuses).not.toContain('PAID');

    // Exporting twice is refused.
    await expectAppError(exportBatch(prisma, actorFor(approver), batch.id), 'INVALID_STATE');
  });

  it('neutralises spreadsheet formulas in exported cells', async () => {
    const operator = await makeOperator({ name: 'Sam Operator' });
    const approver = await makeOperator({ role: 'ADMIN', name: 'Dana Approver' });
    const project = await makeProject(operator.id, { status: 'ACTIVE' });
    // A hostile value typed into a user-entered field.
    const expert = await makeExpert({
      status: 'VERIFIED',
      fullName: '=HYPERLINK("http://evil.test","click")',
    });
    const assignment = await makeConfirmedAssignment(project.id, expert.id);
    const workItem = await createWorkItem(prisma, actorFor(operator), {
      assignmentId: assignment.id,
      title: 'Timeline',
    });
    await submitWork(
      prisma,
      { type: 'EXPERT', expertId: expert.id, label: expert.fullName },
      { workItemId: workItem.id, content: 'Done.' },
    );
    await reviewWork(prisma, actorFor(operator), { workItemId: workItem.id, approve: true });

    const { item } = await draftPaymentFromApprovedWork(prisma, actorFor(operator), {
      workItemId: workItem.id,
    });
    await resolveDiscrepancy(prisma, actorFor(operator), {
      paymentItemId: item.id,
      resolution: 'Rate agreed.',
    }).catch(() => undefined);

    const batch = await createBatch(prisma, actorFor(operator), {
      periodStart: new Date('2026-05-01'),
      periodEnd: new Date('2026-05-31'),
      itemIds: [item.id],
    });
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);
    await approveBatch(prisma, actorFor(approver), { batchId: batch.id });
    const exported = await exportBatch(prisma, actorFor(approver), batch.id);

    // The dangerous cell is quoted AND prefixed so a spreadsheet reads it as text.
    expect(exported.csv).toContain(`"'=HYPERLINK`);
    expect(exported.csv).not.toMatch(/,=HYPERLINK/);
  });

  it('corrects an item by superseding it and invalidates the approval', async () => {
    const { workItem, actor, operator, approver } = await approvedWork();
    const { item } = await draftPaymentFromApprovedWork(prisma, actor, { workItemId: workItem.id });
    const batch = await createBatch(prisma, actorFor(operator), {
      periodStart: new Date('2026-05-01'),
      periodEnd: new Date('2026-05-31'),
      itemIds: [item.id],
    });
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);
    await approveBatch(prisma, actorFor(approver), { batchId: batch.id });

    const result = await correctPaymentItem(prisma, actor, {
      paymentItemId: item.id,
      quantity: '8.00',
      reason: 'Two hours were double counted.',
    });

    expect(result.voided.status).toBe('VOID');
    expect(result.voided.supersededById).toBe(result.replacement.id);
    expect(result.replacement.amountMinor).toBeLessThan(item.amountMinor);
    expect(result.invalidatedBatchId).toBe(batch.id);

    // The approval no longer stands.
    const reopened = await prisma.paymentBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(reopened.status).toBe('DRAFT');
    expect(reopened.approvedById).toBeNull();

    // History survives: the original row still exists with its original figure.
    const original = await prisma.paymentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(original.amountMinor).toBe(item.amountMinor);
    expect(original.voidReason).toContain('double counted');
  });

  it('refuses to correct the same item twice', async () => {
    const { workItem, actor } = await approvedWork();
    const { item } = await draftPaymentFromApprovedWork(prisma, actor, { workItemId: workItem.id });
    await correctPaymentItem(prisma, actor, {
      paymentItemId: item.id,
      quantity: '8.00',
      reason: 'First correction.',
    });
    await expectAppError(
      correctPaymentItem(prisma, actor, {
        paymentItemId: item.id,
        quantity: '7.00',
        reason: 'Second.',
      }),
      'INVALID_STATE',
    );
  });
});

describe('expert support requests', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('lets an expert raise a request only against a project they are on', async () => {
    const { project, expert, operator } = await deliveryFixture();
    const stranger = await makeExpert({ status: 'VERIFIED' });

    const request = await raiseSupportRequest(
      prisma,
      { type: 'EXPERT', expertId: expert.id, label: expert.fullName },
      {
        expertId: expert.id,
        projectId: project.id,
        category: 'ACCESS',
        subject: 'No access',
        message: 'Cannot log in.',
      },
    );
    expect(request.reference).toMatch(/^SUP-/);
    expect(request.responseDueAt).not.toBeNull();

    await expectAppError(
      raiseSupportRequest(
        prisma,
        { type: 'EXPERT', expertId: stranger.id, label: stranger.fullName },
        { expertId: stranger.id, projectId: project.id, subject: 'Nosy', message: 'What is this?' },
      ),
      'INVALID_STATE',
      /only raise a request against a project you are involved in/,
    );
    void operator;
  });

  it('keeps internal notes out of the expert view', async () => {
    const { project, expert, actor } = await deliveryFixture();
    const request = await raiseSupportRequest(
      prisma,
      { type: 'EXPERT', expertId: expert.id, label: expert.fullName },
      { expertId: expert.id, projectId: project.id, subject: 'Access', message: 'Blocked.' },
    );

    await replyToSupport(prisma, actor, {
      requestId: request.id,
      body: 'INTERNAL: chase the client admin, they are slow.',
      internalOnly: true,
    });
    await replyToSupport(prisma, actor, {
      requestId: request.id,
      body: 'We have asked the client for access.',
    });

    const view = await listSupportForExpert(prisma, expert.id);
    const serialised = JSON.stringify(view);
    expect(serialised).toContain('We have asked the client');
    expect(serialised).not.toContain('INTERNAL');
  });

  it('refuses to let an expert post an internal note or read another thread', async () => {
    const first = await deliveryFixture();
    const second = await deliveryFixture();

    const request = await raiseSupportRequest(
      prisma,
      { type: 'EXPERT', expertId: first.expert.id, label: first.expert.fullName },
      { expertId: first.expert.id, projectId: first.project.id, subject: 'Mine', message: 'Help.' },
    );

    await expectAppError(
      replyToSupport(
        prisma,
        { type: 'EXPERT', expertId: first.expert.id, label: first.expert.fullName },
        { requestId: request.id, body: 'Sneaky.', internalOnly: true },
      ),
      'BAD_REQUEST',
      /cannot post internal notes/,
    );

    await expectAppError(
      replyToSupport(
        prisma,
        { type: 'EXPERT', expertId: second.expert.id, label: second.expert.fullName },
        { requestId: request.id, body: 'Not mine.' },
      ),
      'NOT_FOUND',
    );

    const otherView = await listSupportForExpert(prisma, second.expert.id);
    expect(otherView).toHaveLength(0);
  });

  it('blocks readiness while a blocking request is open, and clears on resolution', async () => {
    const { project, expert, actor } = await deliveryFixture();

    // Give the expert everything else they need to be ready.
    await prisma.invitation.create({
      data: {
        projectId: project.id,
        expertId: expert.id,
        status: 'ACCEPTED',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.availabilityWindow.create({
      data: {
        expertId: expert.id,
        projectId: project.id,
        startAt: new Date(Date.now() - 86_400_000),
        endAt: new Date(Date.now() + 60 * 86_400_000),
        hoursPerWeek: 20,
      },
    });

    expect(await readinessBlocker(prisma, project.id, expert.id)).toBeNull();

    const request = await raiseSupportRequest(
      prisma,
      { type: 'EXPERT', expertId: expert.id, label: expert.fullName },
      { expertId: expert.id, projectId: project.id, subject: 'No tooling', message: 'Blocked.' },
    );
    await setBlocking(prisma, actor, { requestId: request.id, blocksReadiness: true });

    const blocker = await readinessBlocker(prisma, project.id, expert.id);
    expect(blocker).toContain(request.reference);

    await resolveSupport(prisma, actor, {
      requestId: request.id,
      resolution: 'Tooling access granted.',
    });
    expect(await readinessBlocker(prisma, project.id, expert.id)).toBeNull();
  });
});

describe('offboarding records human confirmations only', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('opens the checklist idempotently', async () => {
    const { project, expert, assignment, actor } = await deliveryFixture();

    const first = await openOffboarding(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
      assignmentId: assignment.id,
    });
    const second = await openOffboarding(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });

    expect(first.created).toBeGreaterThan(0);
    expect(second.created).toBe(0);
    expect(second.existing).toBe(first.created);
  });

  it('requires a note and never claims the system verified anything', async () => {
    const { project, expert, actor } = await deliveryFixture();
    const { tasks } = await openOffboarding(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    const task = tasks[0]!;

    await expectAppError(
      confirmTask(prisma, actor, { taskId: task.id, note: '   ' }),
      'BAD_REQUEST',
      /cannot verify this itself/,
    );

    const confirmed = await confirmTask(prisma, actor, {
      taskId: task.id,
      note: 'Client admin confirmed removal by email at 14:02.',
    });
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.confirmedById).toBeTruthy();

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { action: 'offboarding.task_confirmed' },
    });
    expect((event.metadata as Record<string, unknown>).verifiedBySystem).toBe(false);
  });

  it('lets only one operator confirm a task', async () => {
    const { project, expert, actor } = await deliveryFixture();
    const { tasks } = await openOffboarding(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    const task = tasks[0]!;

    const clientOne = newClient();
    const clientTwo = newClient();
    try {
      const results = await Promise.allSettled([
        confirmTask(clientOne, actor, { taskId: task.id, note: 'Done by me.' }),
        confirmTask(clientTwo, actor, { taskId: task.id, note: 'Done by me too.' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    } finally {
      await Promise.all([clientOne.$disconnect(), clientTwo.$disconnect()]);
    }
  });
});
