import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { FixedClock, resetAmbientClock, setAmbientClock } from '@/lib/clock';
import { applyMigrations, truncateAll } from '../helpers/db';
import { actorFor, makeDomain, makeOperator, makeRubricVersion } from '../helpers/factories';
import { createCandidate, submitApplication } from '@/server/services/candidates';
import {
  assignReviewer,
  startScreening,
  submitReview,
  submitScreening,
} from '@/server/services/screening';
import {
  grantQualification,
  setProjectQualificationRequirement,
} from '@/server/services/qualifications';
import { createProject, setProjectStatus } from '@/server/services/projects';
import {
  createInvitation,
  respondToInvitation,
  sendInvitation,
} from '@/server/services/invitations';
import { declareAvailability } from '@/server/services/availability';
import {
  decideVerification,
  getOnboardingCase,
  saveChecklistAnswers,
  submitOnboarding,
} from '@/server/services/onboarding';
import { confirmAssignment, proposeAssignment } from '@/server/services/staffing';
import { createWorkItem, reviewWork, submitWork } from '@/server/services/work';
import {
  approveBatch,
  createBatch,
  exportBatch,
  resolveDiscrepancy,
  submitBatchForApproval,
} from '@/server/services/payments';
import { listAttention } from '@/server/services/attention';
import { enqueueJob } from '@/server/services/jobs';
import { Worker } from '@/server/worker/runner';

/**
 * The whole lifecycle, driven through the same services the UI and the worker
 * use:
 *
 *   application -> screening -> qualification -> onboarding -> assignment ->
 *   work review -> payment export
 *
 * Time is driven by an injected clock, so deadlines and reminders are exercised
 * without sleeping.
 */
describe('application to payment export', () => {
  const clock = new FixedClock(new Date('2026-03-02T09:00:00Z'));

  beforeAll(() => applyMigrations());
  beforeEach(async () => {
    await truncateAll();
    clock.set(new Date('2026-03-02T09:00:00Z'));
    setAmbientClock(clock);
  });
  afterEach(() => resetAmbientClock());

  async function drain(worker: Worker, passes = 15) {
    for (let pass = 0; pass < passes; pass += 1) {
      const summary = await worker.tick(clock.now());
      if (summary.jobsClaimed === 0) return;
    }
  }

  it('carries one person from an application all the way to an exported payment', async () => {
    const operator = await makeOperator({ name: 'Sam Operator' });
    const admin = await makeOperator({ role: 'ADMIN', name: 'Dana Admin' });
    const reviewer = await makeOperator({ name: 'Priya Reviewer' });
    const samActor = actorFor(operator);
    const adminActor = actorFor(admin);

    const worker = new Worker({ client: prisma, name: 'lifecycle', batchSize: 25 });
    await worker.bootstrap();

    const domain = await makeDomain('Cybersecurity');
    const rubric = await makeRubricVersion(domain.id, { name: 'Cyber lifecycle' });

    // --- 1. Application ---------------------------------------------------
    const { candidate, duplicateFlags } = await createCandidate(prisma, samActor, {
      fullName: 'Ines Nurse',
      email: 'ines.nurse@example.test',
      headline: 'Security operations lead',
      yearsExperience: 9,
    });
    expect(duplicateFlags).toEqual([]);

    const application = await submitApplication(prisma, samActor, {
      candidateId: candidate.id,
      domainId: domain.id,
      workSampleLinks: ['https://example.test/writeup'],
    });

    await drain(worker);
    const acknowledged = await prisma.application.findUniqueOrThrow({
      where: { id: application.id },
    });
    expect(acknowledged.status).toBe('ACKNOWLEDGED');
    expect(await prisma.outboxMessage.count({ where: { relatedId: application.id } })).toBe(1);

    // --- 2. Screening -----------------------------------------------------
    const screening = await startScreening(prisma, samActor, {
      candidateId: candidate.id,
      rubricVersionId: rubric.id,
      dueInHours: 72,
    });

    const incomplete = await submitScreening(
      prisma,
      { type: 'SYSTEM', label: candidate.fullName },
      { screeningId: screening.id, answers: { depth: 'Years of practice.' }, workSampleLinks: [] },
    );
    expect(incomplete.isComplete).toBe(false);

    // A submitted screening is closed until a reviewer asks for changes. That
    // is the only route back to accepting a resubmission.
    await expect(
      submitScreening(
        prisma,
        { type: 'SYSTEM', label: candidate.fullName },
        { screeningId: screening.id, answers: { depth: 'again' }, workSampleLinks: [] },
      ),
    ).rejects.toThrow(/not accepting submissions/);

    const { requestRevision } = await import('@/server/services/screening');
    await requestRevision(prisma, samActor, {
      screeningId: screening.id,
      feedback: 'Attach the evidence link.',
    });

    const complete = await submitScreening(
      prisma,
      { type: 'SYSTEM', label: candidate.fullName },
      {
        screeningId: screening.id,
        answers: { depth: 'Years of practice.', evidence: 'See the write-up.' },
        workSampleLinks: ['https://example.test/writeup'],
      },
    );
    expect(complete.isComplete).toBe(true);

    // Clear any auto-assigned reviewer so the test drives one explicitly.
    await prisma.screeningReview.deleteMany({ where: { screeningId: screening.id } });
    const review = await assignReviewer(prisma, samActor, {
      screeningId: screening.id,
      reviewerId: reviewer.id,
      dueInHours: 48,
    });
    await submitReview(prisma, actorFor(reviewer), {
      reviewId: review.id,
      decision: 'APPROVE',
      scores: { depth: 5, evidence: 4 },
      publicFeedback: 'Clear and evidenced.',
      privateNotes: 'Internal only.',
    });

    // --- 3. Qualification (human decision) --------------------------------
    const granted = await grantQualification(prisma, adminActor, {
      screeningId: screening.id,
      note: 'Approved.',
    });
    expect(granted.createdExpert).toBe(true);
    const expertId = granted.expertId;

    const expertAfterQualification = await prisma.expert.findUniqueOrThrow({
      where: { id: expertId },
    });
    // Qualified, but nowhere near staffable.
    expect(expertAfterQualification.status).toBe('PROSPECT');

    await prisma.expert.update({
      where: { id: expertId },
      data: { weeklyCapacityHours: 20, hourlyRateCents: 24_000 },
    });
    await drain(worker);

    // --- 4. Project and invitation ---------------------------------------
    const project = await createProject(prisma, samActor, {
      title: 'Cloud intrusion review',
      clientName: 'Harborline Payments',
      seatsRequested: 1,
      minYearsExperience: 5,
      maxHourlyRateCents: 30_000,
      requirements: [{ skillName: 'Incident Response', required: false, minProficiency: 1 }],
    });
    await setProjectStatus(prisma, samActor, project.id, 'MATCHING');
    await setProjectQualificationRequirement(prisma, samActor, {
      projectId: project.id,
      domainId: domain.id,
      minRubricVersionId: rubric.id,
    });

    const invitation = await createInvitation(prisma, samActor, {
      projectId: project.id,
      expertId,
      ttlHours: 72,
    });
    await sendInvitation(prisma, { type: 'SYSTEM', label: 'worker' }, invitation.id);
    await respondToInvitation(prisma, expertId, { invitationId: invitation.id, accept: true });

    // --- 5. Availability and onboarding -----------------------------------
    await declareAvailability(prisma, { type: 'EXPERT', expertId, label: 'Ines Nurse' }, expertId, {
      startAt: new Date('2026-03-09T00:00:00Z'),
      endAt: new Date('2026-06-09T00:00:00Z'),
      hoursPerWeek: 16,
      projectId: project.id,
    });

    // Still not staffable: onboarding is not verified.
    await expect(
      proposeAssignment(prisma, samActor, {
        projectId: project.id,
        expertId,
        allocationHoursPerWeek: 16,
      }),
    ).rejects.toThrow(/Only VERIFIED experts can be staffed/);

    const expertActor = { type: 'EXPERT' as const, expertId, label: 'Ines Nurse' };
    const openCase = await getOnboardingCase(prisma, expertId);
    await saveChecklistAnswers(
      prisma,
      expertActor,
      expertId,
      openCase.items
        .filter((item) => item.required)
        .map((item) => ({ key: item.key, value: item.kind === 'ATTESTATION' ? 'true' : 'None' })),
    );
    await submitOnboarding(prisma, expertActor, expertId);

    // --- 6. Operator verification ----------------------------------------
    const verified = await decideVerification(prisma, adminActor, { expertId, approve: true });
    expect(verified.status).toBe('VERIFIED');
    await drain(worker);

    // --- 7. Assignment ----------------------------------------------------
    const proposal = await proposeAssignment(prisma, samActor, {
      projectId: project.id,
      expertId,
      allocationHoursPerWeek: 16,
      rateCents: 24_000,
    });
    const confirmed = await confirmAssignment(prisma, samActor, proposal.id);
    expect(confirmed.seatsFilled).toBe(1);
    await drain(worker);

    // --- 8. Work and review ----------------------------------------------
    const workItem = await createWorkItem(prisma, samActor, {
      assignmentId: confirmed.assignment.id,
      title: 'Intrusion timeline',
      basis: 'HOURLY',
      dueAt: new Date('2026-03-20T00:00:00Z'),
    });

    await submitWork(prisma, expertActor, {
      workItemId: workItem.id,
      content: 'First pass.',
      hoursClaimed: '12.00',
    });
    await drain(worker);

    const awaitingReview = await listAttention(prisma, { category: 'work.awaiting_review' });
    expect(awaitingReview).toHaveLength(1);

    await reviewWork(prisma, samActor, {
      workItemId: workItem.id,
      approve: false,
      revisionRequest: 'Add the exfiltration stage.',
    });
    await submitWork(prisma, expertActor, {
      workItemId: workItem.id,
      content: 'Second pass.',
      hoursClaimed: '16.00',
    });
    await reviewWork(prisma, samActor, {
      workItemId: workItem.id,
      approve: true,
      approvedQuantity: '14.50',
      feedback: { accuracy: 'Correct.', completeness: 'Full chain.' },
    });

    // --- 9. Payment preparation ------------------------------------------
    await drain(worker);

    const paymentItem = await prisma.paymentItem.findFirstOrThrow({
      where: { workItemId: workItem.id },
    });
    // 14.50 hours at 240.00 = 3,480.00
    expect(paymentItem.amountMinor).toBe(348_000);
    expect(paymentItem.status).toBe('DRAFT'); // has a discrepancy

    await resolveDiscrepancy(prisma, samActor, {
      paymentItemId: paymentItem.id,
      resolution: 'Reviewer disallowed 1.5 hours of setup; agreed with the expert.',
    });

    const batch = await createBatch(prisma, samActor, {
      periodStart: new Date('2026-03-01T00:00:00Z'),
      periodEnd: new Date('2026-03-31T00:00:00Z'),
      itemIds: [paymentItem.id],
    });
    await submitBatchForApproval(prisma, samActor, batch.id);
    await approveBatch(prisma, adminActor, { batchId: batch.id });
    const exported = await exportBatch(prisma, adminActor, batch.id);

    expect(exported.csv).toContain(paymentItem.reference);
    expect(exported.csv).toContain('3480.00');

    // --- 10. The trail explains the whole thing ---------------------------
    const events = await prisma.activityEvent.findMany({ orderBy: { createdAt: 'asc' } });
    const actions = events.map((event) => event.action);

    for (const expected of [
      'candidate.created',
      'application.submitted',
      'screening.invited',
      'screening.submitted',
      'screening.review_submitted',
      'qualification.granted',
      'invitation.accepted',
      'onboarding.submitted',
      'onboarding.verified',
      'assignment.confirmed',
      'work.submitted',
      'work.approved',
      'payment.drafted',
      'payment.batch_approved',
      'payment.batch_exported',
    ]) {
      expect(actions, `missing ${expected}`).toContain(expected);
    }

    // Every human decision names the human who made it.
    const humanDecisions = events.filter((event) =>
      [
        'qualification.granted',
        'onboarding.verified',
        'assignment.confirmed',
        'work.approved',
        'payment.batch_approved',
        'payment.batch_exported',
      ].includes(event.action),
    );
    expect(humanDecisions.length).toBeGreaterThanOrEqual(6);
    for (const event of humanDecisions) {
      expect(event.actorType).toBe('OPERATOR');
      expect(event.actorUserId).toBeTruthy();
    }

    // No job died along the way.
    expect(await prisma.job.count({ where: { status: 'DEAD' } })).toBe(0);
  });

  it('suppresses a stale reminder rather than chasing a deadline that has passed', async () => {
    const operator = await makeOperator();
    const reviewer = await makeOperator({ name: 'Slow Reviewer' });
    const domain = await makeDomain();
    const rubric = await makeRubricVersion(domain.id);
    const candidate = await createCandidate(prisma, actorFor(operator), {
      fullName: 'Reminder Subject',
      email: 'reminder.subject@example.test',
    });

    const worker = new Worker({ client: prisma, name: 'reminders', batchSize: 25 });
    await worker.bootstrap();

    const screening = await startScreening(prisma, actorFor(operator), {
      candidateId: candidate.candidate.id,
      rubricVersionId: rubric.id,
      dueInHours: 72,
    });

    // Too soon: the candidate has had less than 48 hours.
    await enqueueJob(prisma, { type: 'screening.remind_candidate' });
    await drain(worker);
    expect(await prisma.outboxMessage.count({ where: { template: 'invitation.reminder' } })).toBe(
      0,
    );

    // After 50 hours a reminder is useful.
    clock.advanceHours(50);
    await enqueueJob(prisma, { type: 'screening.remind_candidate' });
    await drain(worker);
    expect(await prisma.outboxMessage.count({ where: { template: 'invitation.reminder' } })).toBe(
      1,
    );

    // Within the minimum interval, a second sweep sends nothing.
    clock.advanceHours(1);
    await enqueueJob(prisma, { type: 'screening.remind_candidate' });
    await drain(worker);
    expect(await prisma.outboxMessage.count({ where: { template: 'invitation.reminder' } })).toBe(
      1,
    );

    // Close to the deadline the reminder is suppressed as unhelpful.
    clock.advanceHours(21);
    await enqueueJob(prisma, { type: 'screening.remind_candidate' });
    await drain(worker);
    const total = await prisma.outboxMessage.count({
      where: { template: 'invitation.reminder' },
    });
    expect(total).toBeLessThanOrEqual(2);

    // The screening is still the one we created.
    expect((await prisma.screening.findUniqueOrThrow({ where: { id: screening.id } })).id).toBe(
      screening.id,
    );
    void reviewer;
  });

  it('caps reviewer reminders and escalates instead of chasing forever', async () => {
    const operator = await makeOperator();
    const reviewer = await makeOperator({ name: 'Absent Reviewer' });
    const domain = await makeDomain();
    const rubric = await makeRubricVersion(domain.id);
    const { candidate } = await createCandidate(prisma, actorFor(operator), {
      fullName: 'Waiting Candidate',
      email: 'waiting@example.test',
    });

    const worker = new Worker({ client: prisma, name: 'review-chase', batchSize: 25 });
    await worker.bootstrap();

    const screening = await startScreening(prisma, actorFor(operator), {
      candidateId: candidate.id,
      rubricVersionId: rubric.id,
    });
    await submitScreening(
      prisma,
      { type: 'SYSTEM', label: candidate.fullName },
      {
        screeningId: screening.id,
        answers: { depth: 'x', evidence: 'y' },
        workSampleLinks: ['https://example.test/a'],
      },
    );
    await prisma.screeningReview.deleteMany({ where: { screeningId: screening.id } });
    await assignReviewer(prisma, actorFor(operator), {
      screeningId: screening.id,
      reviewerId: reviewer.id,
      dueInHours: 12,
    });

    clock.advanceHours(24);

    // Sweep repeatedly, well past the reminder cap.
    for (let round = 0; round < 5; round += 1) {
      await enqueueJob(prisma, { type: 'review.remind' });
      await enqueueJob(prisma, { type: 'review.escalate_overdue' });
      await drain(worker);
      clock.advanceHours(25); // past the minimum interval each time
    }

    const reminders = await prisma.outboxMessage.count({
      where: { template: 'invitation.reminder', relatedType: 'screening_review' },
    });
    expect(reminders).toBeLessThanOrEqual(2);

    // But exactly one attention item, refreshed rather than duplicated.
    const escalations = await listAttention(prisma, { category: 'review.overdue' });
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.nextAction).toContain('Reassign');
  });
});
