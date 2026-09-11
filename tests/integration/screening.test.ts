import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { applyMigrations, newClient, truncateAll } from '../helpers/db';
import {
  actorFor,
  makeCandidate,
  makeDomain,
  makeExpert,
  makeOperator,
  makeProject,
  makeQualification,
  makeRubricVersion,
} from '../helpers/factories';
import {
  assignReviewer,
  createDraftVersion,
  createTemplate,
  getScreeningForCandidate,
  publishVersion,
  requestRevision,
  resolveConflict,
  startScreening,
  submitReview,
  submitScreening,
  updateDraftVersion,
} from '@/server/services/screening';
import {
  checkQualificationEligibility,
  grantQualification,
  rejectScreening,
  resolveRereview,
  setProjectQualificationRequirement,
} from '@/server/services/qualifications';
import { createCandidate, resolveDuplicate, submitApplication } from '@/server/services/candidates';
import { proposeAssignment } from '@/server/services/staffing';

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

describe('rubric versions are immutable once published', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('refuses to edit a published version and directs you to a new one', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const actor = actorFor(admin);
    const domain = await makeDomain();

    const template = await createTemplate(prisma, actor, { name: 'Cyber v1', domainId: domain.id });
    const draft = await createDraftVersion(prisma, actor, {
      templateId: template.id,
      criteria: [{ key: 'depth', label: 'Depth' }],
    });

    // A draft is editable.
    await updateDraftVersion(prisma, actor, draft.id, { passThreshold: 12 });

    const published = await publishVersion(prisma, actor, draft.id);
    expect(published.status).toBe('PUBLISHED');

    const error = await expectAppError(
      updateDraftVersion(prisma, actor, published.id, { passThreshold: 99 }),
      'INVALID_STATE',
      /immutable/,
    );
    expect(error.message).toContain('Create a new version');

    const stored = await prisma.screeningRubricVersion.findUniqueOrThrow({
      where: { id: published.id },
    });
    expect(stored.passThreshold).toBe(12);
  });

  it('refuses to publish the same version twice', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const actor = actorFor(admin);
    const domain = await makeDomain();
    const template = await createTemplate(prisma, actor, { name: 'Cyber', domainId: domain.id });
    const draft = await createDraftVersion(prisma, actor, {
      templateId: template.id,
      criteria: [{ key: 'depth', label: 'Depth' }],
    });

    await publishVersion(prisma, actor, draft.id);
    await expectAppError(publishVersion(prisma, actor, draft.id), 'INVALID_STATE', /already/);
  });

  it('refuses a second open draft on the same template', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const actor = actorFor(admin);
    const domain = await makeDomain();
    const template = await createTemplate(prisma, actor, { name: 'Cyber', domainId: domain.id });

    await createDraftVersion(prisma, actor, {
      templateId: template.id,
      criteria: [{ key: 'depth', label: 'Depth' }],
    });
    await expectAppError(
      createDraftVersion(prisma, actor, { templateId: template.id }),
      'CONFLICT',
      /still a draft/,
    );
  });

  it('copies the published criteria into the next draft', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const actor = actorFor(admin);
    const domain = await makeDomain();
    const template = await createTemplate(prisma, actor, { name: 'Cyber', domainId: domain.id });

    const v1 = await createDraftVersion(prisma, actor, {
      templateId: template.id,
      criteria: [
        { key: 'depth', label: 'Depth' },
        { key: 'evidence', label: 'Evidence' },
      ],
    });
    await publishVersion(prisma, actor, v1.id);

    const v2 = await createDraftVersion(prisma, actor, { templateId: template.id });
    expect(v2.version).toBe(2);

    const criteria = await prisma.rubricCriterion.findMany({ where: { rubricVersionId: v2.id } });
    expect(criteria.map((c) => c.key).sort()).toEqual(['depth', 'evidence']);
  });

  it('keeps a decided screening pinned to the version it ran against', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const actor = actorFor(admin);
    const domain = await makeDomain();
    const v1 = await makeRubricVersion(domain.id, { name: 'Pinned', version: 1 });
    const candidate = await makeCandidate();

    const screening = await startScreening(prisma, actor, {
      candidateId: candidate.id,
      rubricVersionId: v1.id,
    });

    // A newer version appears afterwards.
    const v2 = await makeRubricVersion(domain.id, { name: 'Pinned', version: 2 });
    expect(v2.version).toBe(2);

    const stored = await prisma.screening.findUniqueOrThrow({ where: { id: screening.id } });
    expect(stored.rubricVersionId).toBe(v1.id);
  });
});

describe('screening submissions and reviews', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  async function fixture() {
    const admin = await makeOperator({ role: 'ADMIN', name: 'Admin One' });
    const reviewerA = await makeOperator({ name: 'Reviewer A' });
    const reviewerB = await makeOperator({ name: 'Reviewer B' });
    const domain = await makeDomain();
    const rubric = await makeRubricVersion(domain.id);
    const candidate = await makeCandidate();
    const screening = await startScreening(prisma, actorFor(admin), {
      candidateId: candidate.id,
      rubricVersionId: rubric.id,
    });
    return { admin, reviewerA, reviewerB, domain, rubric, candidate, screening };
  }

  it('accepts an incomplete submission and records what is missing', async () => {
    const { screening, candidate } = await fixture();

    const result = await submitScreening(
      prisma,
      { type: 'SYSTEM', label: candidate.fullName },
      {
        screeningId: screening.id,
        // 'evidence' requires a work sample link; none supplied.
        answers: { depth: 'Ten years of hands-on practice.' },
        workSampleLinks: [],
      },
    );

    expect(result.isComplete).toBe(false);
    expect(result.missingEvidence).toHaveLength(1);
    expect(result.missingEvidence[0]).toContain('work sample link');

    // It is stored, not rejected: the operator can still see what was attempted.
    const stored = await prisma.screeningSubmission.findFirstOrThrow({
      where: { screeningId: screening.id },
    });
    expect(stored.isComplete).toBe(false);
    expect(stored.revision).toBe(1);
    expect((await prisma.screening.findUniqueOrThrow({ where: { id: screening.id } })).status).toBe(
      'SUBMITTED',
    );
  });

  it('records a complete submission as complete', async () => {
    const { screening, candidate } = await fixture();
    const result = await submitScreening(
      prisma,
      { type: 'SYSTEM', label: candidate.fullName },
      {
        screeningId: screening.id,
        answers: { depth: 'Ten years.', evidence: 'See the linked write-up.' },
        workSampleLinks: ['https://example.test/write-up'],
      },
    );
    expect(result.isComplete).toBe(true);
    expect(result.missingEvidence).toEqual([]);
  });

  it('rejects a work sample link that is not a URL', async () => {
    const { screening, candidate } = await fixture();
    await expectAppError(
      submitScreening(
        prisma,
        { type: 'SYSTEM', label: candidate.fullName },
        {
          screeningId: screening.id,
          answers: { depth: 'x', evidence: 'y' },
          workSampleLinks: ['javascript:alert(1)'],
        },
      ),
      'BAD_REQUEST',
      /http or https/,
    );
  });

  it('lets only the assigned reviewer submit the review', async () => {
    const { screening, candidate, admin, reviewerA, reviewerB } = await fixture();
    await submitScreening(
      prisma,
      { type: 'SYSTEM', label: candidate.fullName },
      {
        screeningId: screening.id,
        answers: { depth: 'x', evidence: 'y' },
        workSampleLinks: ['https://example.test/a'],
      },
    );

    const review = await assignReviewer(prisma, actorFor(admin), {
      screeningId: screening.id,
      reviewerId: reviewerA.id,
    });

    await expectAppError(
      submitReview(prisma, actorFor(reviewerB), { reviewId: review.id, decision: 'APPROVE' }),
      'FORBIDDEN',
      /assigned reviewer/,
    );

    const result = await submitReview(prisma, actorFor(reviewerA), {
      reviewId: review.id,
      decision: 'APPROVE',
      scores: { depth: 5 },
    });
    expect(result.conflict).toBeNull();
  });

  it('rejects a score outside the criterion range or for an unknown criterion', async () => {
    const { screening, candidate, admin, reviewerA } = await fixture();
    await submitScreening(
      prisma,
      { type: 'SYSTEM', label: candidate.fullName },
      {
        screeningId: screening.id,
        answers: { depth: 'x', evidence: 'y' },
        workSampleLinks: ['https://example.test/a'],
      },
    );
    const review = await assignReviewer(prisma, actorFor(admin), {
      screeningId: screening.id,
      reviewerId: reviewerA.id,
    });

    await expectAppError(
      submitReview(prisma, actorFor(reviewerA), {
        reviewId: review.id,
        decision: 'APPROVE',
        scores: { depth: 99 },
      }),
      'BAD_REQUEST',
      /between 0 and 5/,
    );
    await expectAppError(
      submitReview(prisma, actorFor(reviewerA), {
        reviewId: review.id,
        decision: 'APPROVE',
        scores: { invented: 3 },
      }),
      'BAD_REQUEST',
      /Unknown rubric criterion/,
    );
  });

  it('requires actionable feedback when asking for a revision', async () => {
    const { screening, candidate, admin, reviewerA } = await fixture();
    await submitScreening(
      prisma,
      { type: 'SYSTEM', label: candidate.fullName },
      {
        screeningId: screening.id,
        answers: { depth: 'x', evidence: 'y' },
        workSampleLinks: ['https://example.test/a'],
      },
    );
    const review = await assignReviewer(prisma, actorFor(admin), {
      screeningId: screening.id,
      reviewerId: reviewerA.id,
    });

    await expectAppError(
      submitReview(prisma, actorFor(reviewerA), {
        reviewId: review.id,
        decision: 'REQUEST_REVISION',
        publicFeedback: '   ',
      }),
      'BAD_REQUEST',
      /feedback the candidate can act on/,
    );
  });

  it('raises a conflict when reviewers disagree and refuses to break the tie', async () => {
    const { screening, candidate, admin, reviewerA, reviewerB } = await fixture();
    await submitScreening(
      prisma,
      { type: 'SYSTEM', label: candidate.fullName },
      {
        screeningId: screening.id,
        answers: { depth: 'x', evidence: 'y' },
        workSampleLinks: ['https://example.test/a'],
      },
    );

    const reviewA = await assignReviewer(prisma, actorFor(admin), {
      screeningId: screening.id,
      reviewerId: reviewerA.id,
    });
    const reviewB = await assignReviewer(prisma, actorFor(admin), {
      screeningId: screening.id,
      reviewerId: reviewerB.id,
    });

    await submitReview(prisma, actorFor(reviewerA), { reviewId: reviewA.id, decision: 'APPROVE' });
    const second = await submitReview(prisma, actorFor(reviewerB), {
      reviewId: reviewB.id,
      decision: 'REJECT',
    });

    expect(second.conflict).not.toBeNull();
    expect(second.conflict!.status).toBe('OPEN');
    expect(second.conflict!.summary).toContain('APPROVE');
    expect(second.conflict!.summary).toContain('REJECT');

    // Qualification is blocked until a human resolves the disagreement.
    await expectAppError(
      grantQualification(prisma, actorFor(admin), { screeningId: screening.id }),
      'INVALID_STATE',
      /Reviewers disagree/,
    );

    await resolveConflict(prisma, actorFor(admin), {
      screeningId: screening.id,
      resolution: 'APPROVE',
      note: 'The approving reviewer had the fuller picture.',
    });

    const resolved = await grantQualification(prisma, actorFor(admin), {
      screeningId: screening.id,
    });
    expect(resolved.qualification.status).toBe('ACTIVE');
  });

  it('requires a note to resolve a conflict, and resolves it only once', async () => {
    const { screening, candidate, admin, reviewerA, reviewerB } = await fixture();
    await submitScreening(
      prisma,
      { type: 'SYSTEM', label: candidate.fullName },
      {
        screeningId: screening.id,
        answers: { depth: 'x', evidence: 'y' },
        workSampleLinks: ['https://example.test/a'],
      },
    );
    const a = await assignReviewer(prisma, actorFor(admin), {
      screeningId: screening.id,
      reviewerId: reviewerA.id,
    });
    const b = await assignReviewer(prisma, actorFor(admin), {
      screeningId: screening.id,
      reviewerId: reviewerB.id,
    });
    await submitReview(prisma, actorFor(reviewerA), { reviewId: a.id, decision: 'APPROVE' });
    await submitReview(prisma, actorFor(reviewerB), { reviewId: b.id, decision: 'REJECT' });

    await expectAppError(
      resolveConflict(prisma, actorFor(admin), {
        screeningId: screening.id,
        resolution: 'APPROVE',
        note: '  ',
      }),
      'BAD_REQUEST',
    );

    await resolveConflict(prisma, actorFor(admin), {
      screeningId: screening.id,
      resolution: 'APPROVE',
      note: 'Decided.',
    });
    await expectAppError(
      resolveConflict(prisma, actorFor(admin), {
        screeningId: screening.id,
        resolution: 'REJECT',
        note: 'Changed my mind.',
      }),
      'INVALID_STATE',
    );
  });

  it('never exposes private reviewer notes to the candidate', async () => {
    const { screening, candidate, admin, reviewerA } = await fixture();
    await submitScreening(
      prisma,
      { type: 'SYSTEM', label: candidate.fullName },
      {
        screeningId: screening.id,
        answers: { depth: 'x', evidence: 'y' },
        workSampleLinks: ['https://example.test/a'],
      },
    );
    const review = await assignReviewer(prisma, actorFor(admin), {
      screeningId: screening.id,
      reviewerId: reviewerA.id,
    });
    await submitReview(prisma, actorFor(reviewerA), {
      reviewId: review.id,
      decision: 'REQUEST_REVISION',
      publicFeedback: 'Please add the missing link.',
      privateNotes: 'INTERNAL: weak on cloud, would not staff on a regulated client.',
    });

    const candidateView = await getScreeningForCandidate(prisma, screening.id, candidate.id);
    const serialised = JSON.stringify(candidateView);

    expect(serialised).not.toContain('INTERNAL');
    expect(serialised).not.toContain('would not staff');
    expect(serialised).not.toContain('privateNotes');
    expect(serialised).toContain('Please add the missing link.');
  });

  it("refuses to return another candidate's screening", async () => {
    const { screening } = await fixture();
    const other = await makeCandidate();
    await expectAppError(getScreeningForCandidate(prisma, screening.id, other.id), 'NOT_FOUND');
  });

  it('refuses a qualification with no submitted review', async () => {
    const { screening, candidate, admin } = await fixture();
    await submitScreening(
      prisma,
      { type: 'SYSTEM', label: candidate.fullName },
      {
        screeningId: screening.id,
        answers: { depth: 'x', evidence: 'y' },
        workSampleLinks: ['https://example.test/a'],
      },
    );
    await expectAppError(
      grantQualification(prisma, actorFor(admin), { screeningId: screening.id }),
      'INVALID_STATE',
      /at least one submitted human review/,
    );
  });

  it('requires a reason to reject, and keeps the candidate on file', async () => {
    const { screening, candidate, admin, reviewerA } = await fixture();
    await submitScreening(
      prisma,
      { type: 'SYSTEM', label: candidate.fullName },
      {
        screeningId: screening.id,
        answers: { depth: 'x', evidence: 'y' },
        workSampleLinks: ['https://example.test/a'],
      },
    );
    const review = await assignReviewer(prisma, actorFor(admin), {
      screeningId: screening.id,
      reviewerId: reviewerA.id,
    });
    await submitReview(prisma, actorFor(reviewerA), { reviewId: review.id, decision: 'REJECT' });

    await expectAppError(
      rejectScreening(prisma, actorFor(admin), { screeningId: screening.id, note: '' }),
      'BAD_REQUEST',
    );

    await rejectScreening(prisma, actorFor(admin), {
      screeningId: screening.id,
      note: 'Not enough hands-on depth yet.',
    });

    const stored = await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(stored.stage).toBe('REJECTED');
    // The person is not deleted; their history stays.
    expect(stored.fullName).toBe(candidate.fullName);
  });

  it('lets a revision reopen the submission window', async () => {
    const { screening, candidate, admin } = await fixture();
    await submitScreening(
      prisma,
      { type: 'SYSTEM', label: candidate.fullName },
      { screeningId: screening.id, answers: { depth: 'x' }, workSampleLinks: [] },
    );
    await requestRevision(prisma, actorFor(admin), {
      screeningId: screening.id,
      feedback: 'Add the evidence link.',
    });

    const second = await submitScreening(
      prisma,
      { type: 'SYSTEM', label: candidate.fullName },
      {
        screeningId: screening.id,
        answers: { depth: 'x', evidence: 'y' },
        workSampleLinks: ['https://example.test/a'],
      },
    );
    expect(second.revision).toBe(2);
    expect(second.isComplete).toBe(true);
  });
});

describe('qualification does not grant assignment', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('leaves every existing staffing gate in place for a qualified expert', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const actor = actorFor(admin);
    const domain = await makeDomain();
    const rubric = await makeRubricVersion(domain.id);
    const project = await makeProject(admin.id, { status: 'STAFFING' });
    await setProjectQualificationRequirement(prisma, actor, {
      projectId: project.id,
      domainId: domain.id,
      minRubricVersionId: rubric.id,
    });

    // Qualified, but nothing else done.
    const expert = await makeExpert({ status: 'PROSPECT' });
    await makeQualification(expert.id, domain.id, rubric.id, admin.id);

    const eligibility = await checkQualificationEligibility(prisma, project.id, expert.id);
    expect(eligibility.eligible).toBe(true);

    // Still cannot be staffed: onboarding is not verified.
    await expectAppError(
      proposeAssignment(prisma, actor, {
        projectId: project.id,
        expertId: expert.id,
        allocationHoursPerWeek: 10,
      }),
      'INVALID_STATE',
      /Only VERIFIED experts can be staffed/,
    );
  });

  it('reports why an expert fails a project qualification requirement', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const actor = actorFor(admin);
    const domain = await makeDomain();
    const v1 = await makeRubricVersion(domain.id, { name: 'Bar', version: 1 });
    const v2 = await makeRubricVersion(domain.id, { name: 'Bar', version: 2 });

    const project = await makeProject(admin.id, { status: 'STAFFING' });
    await setProjectQualificationRequirement(prisma, actor, {
      projectId: project.id,
      domainId: domain.id,
      minRubricVersionId: v2.id,
    });

    const expert = await makeExpert({ status: 'VERIFIED' });
    await makeQualification(expert.id, domain.id, v1.id, admin.id);

    const eligibility = await checkQualificationEligibility(prisma, project.id, expert.id);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toContain('project needs v2');
    expect(eligibility.missing[0]!.held).toBe(1);
  });

  it('is eligible when the project sets no qualification requirement', async () => {
    const admin = await makeOperator();
    const project = await makeProject(admin.id);
    const expert = await makeExpert();
    const eligibility = await checkQualificationEligibility(prisma, project.id, expert.id);
    expect(eligibility.eligible).toBe(true);
  });
});

describe('raising a project bar surfaces re-review, never revokes', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('flags older qualifications and leaves their rubric version intact', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const actor = actorFor(admin);
    const domain = await makeDomain();
    const v1 = await makeRubricVersion(domain.id, { name: 'Ladder', version: 1 });
    const v2 = await makeRubricVersion(domain.id, { name: 'Ladder', version: 2 });

    const expertA = await makeExpert({ status: 'VERIFIED' });
    const expertB = await makeExpert({ status: 'VERIFIED' });
    const oldQualification = await makeQualification(expertA.id, domain.id, v1.id, admin.id);
    const newQualification = await makeQualification(expertB.id, domain.id, v2.id, admin.id);

    const project = await makeProject(admin.id, { status: 'STAFFING' });
    const result = await setProjectQualificationRequirement(prisma, actor, {
      projectId: project.id,
      domainId: domain.id,
      minRubricVersionId: v2.id,
    });

    expect(result.flaggedForRereview).toBe(1);
    expect(result.affectedExpertIds).toEqual([expertA.id]);

    const flagged = await prisma.qualification.findUniqueOrThrow({
      where: { id: oldQualification.id },
    });
    expect(flagged.status).toBe('NEEDS_REREVIEW');
    // Nothing was revoked, and the rubric version it was decided against stands.
    expect(flagged.rubricVersionId).toBe(v1.id);
    expect(flagged.revokedAt).toBeNull();
    expect(flagged.rereviewReason).toContain('v2');

    const untouched = await prisma.qualification.findUniqueOrThrow({
      where: { id: newQualification.id },
    });
    expect(untouched.status).toBe('ACTIVE');
  });

  it('never auto-approves anyone when the bar is raised', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const actor = actorFor(admin);
    const domain = await makeDomain();
    const v1 = await makeRubricVersion(domain.id, { name: 'Ladder', version: 1 });
    const v2 = await makeRubricVersion(domain.id, { name: 'Ladder', version: 2 });

    const expert = await makeExpert({ status: 'VERIFIED' });
    await makeQualification(expert.id, domain.id, v1.id, admin.id);

    const project = await makeProject(admin.id, { status: 'STAFFING' });
    await setProjectQualificationRequirement(prisma, actor, {
      projectId: project.id,
      domainId: domain.id,
      minRubricVersionId: v2.id,
    });

    const atV2 = await prisma.qualification.count({
      where: { expertId: expert.id, rubricVersionId: v2.id },
    });
    expect(atV2).toBe(0);
  });

  it('lets a human uphold or supersede a flagged qualification', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const actor = actorFor(admin);
    const domain = await makeDomain();
    const v1 = await makeRubricVersion(domain.id, { name: 'Ladder', version: 1 });
    const v2 = await makeRubricVersion(domain.id, { name: 'Ladder', version: 2 });
    const expert = await makeExpert({ status: 'VERIFIED' });
    const qualification = await makeQualification(expert.id, domain.id, v1.id, admin.id);
    const project = await makeProject(admin.id, { status: 'STAFFING' });

    await setProjectQualificationRequirement(prisma, actor, {
      projectId: project.id,
      domainId: domain.id,
      minRubricVersionId: v2.id,
    });

    await expectAppError(
      resolveRereview(prisma, actor, {
        qualificationId: qualification.id,
        stillValid: true,
        note: '',
      }),
      'BAD_REQUEST',
    );

    const upheld = await resolveRereview(prisma, actor, {
      qualificationId: qualification.id,
      stillValid: true,
      note: 'Checked their recent cloud work; the newer bar is met in practice.',
    });
    expect(upheld.status).toBe('ACTIVE');
    expect(upheld.rereviewReason).toBeNull();
  });
});

describe('duplicate people are never merged automatically', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('flags an email match against an existing expert and holds the candidate', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const existing = await makeExpert({ email: 'shared@example.test', fullName: 'Shared Person' });

    const result = await createCandidate(prisma, actor, {
      fullName: 'Shared Person',
      email: 'shared@example.test',
    });

    expect(result.duplicateFlags.length).toBeGreaterThan(0);
    expect(result.duplicateFlags[0]!.matchedExpertId).toBe(existing.id);
    expect(result.duplicateFlags[0]!.score).toBeGreaterThan(90);

    const stored = await prisma.candidate.findUniqueOrThrow({ where: { id: result.candidate.id } });
    expect(stored.stage).toBe('DUPLICATE_HOLD');

    // Both records still exist. Nothing was merged.
    expect(await prisma.expert.count({ where: { id: existing.id } })).toBe(1);
    expect(await prisma.candidate.count({ where: { id: result.candidate.id } })).toBe(1);
  });

  it('flags a name match at lower confidence', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    await makeExpert({ email: 'a@example.test', fullName: 'Same Name' });

    const result = await createCandidate(prisma, actor, {
      fullName: 'Same Name',
      email: 'different@example.test',
    });
    expect(result.duplicateFlags).toHaveLength(1);
    expect(result.duplicateFlags[0]!.score).toBeLessThan(90);
  });

  it('blocks screening while a duplicate question is open', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const domain = await makeDomain();
    const rubric = await makeRubricVersion(domain.id);
    await makeExpert({ email: 'shared@example.test' });

    const { candidate } = await createCandidate(prisma, actor, {
      fullName: 'Shared Person',
      email: 'shared@example.test',
    });

    await expectAppError(
      startScreening(prisma, actor, { candidateId: candidate.id, rubricVersionId: rubric.id }),
      'INVALID_STATE',
      /duplicate-person decision/,
    );
  });

  it('releases the hold when a human says they are different people', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    await makeExpert({ email: 'a@example.test', fullName: 'Same Name' });
    const { candidate, duplicateFlags } = await createCandidate(prisma, actor, {
      fullName: 'Same Name',
      email: 'b@example.test',
    });

    await expectAppError(
      resolveDuplicate(prisma, actor, {
        flagId: duplicateFlags[0]!.id,
        samePerson: false,
        note: '',
      }),
      'BAD_REQUEST',
    );

    await resolveDuplicate(prisma, actor, {
      flagId: duplicateFlags[0]!.id,
      samePerson: false,
      note: 'Different people; confirmed by phone.',
    });

    const released = await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(released.stage).toBe('NEW');
  });

  it('withdraws the newer record when a human confirms a match, keeping both on file', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const existing = await makeExpert({ email: 'shared@example.test' });
    const { candidate, duplicateFlags } = await createCandidate(prisma, actor, {
      fullName: 'Shared Person',
      email: 'shared@example.test',
    });

    await resolveDuplicate(prisma, actor, {
      flagId: duplicateFlags[0]!.id,
      samePerson: true,
      note: 'Already in the network as an expert.',
    });

    const stored = await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(stored.stage).toBe('WITHDRAWN');
    expect(stored.notes).toContain('[duplicate]');
    expect(await prisma.expert.count({ where: { id: existing.id } })).toBe(1);
  });

  it('lets only one operator resolve a flag when two try at once', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    await makeExpert({ email: 'shared@example.test' });
    const { duplicateFlags } = await createCandidate(prisma, actor, {
      fullName: 'Shared Person',
      email: 'shared@example.test',
    });

    const clientOne = newClient();
    const clientTwo = newClient();
    try {
      const results = await Promise.allSettled([
        resolveDuplicate(clientOne, actor, {
          flagId: duplicateFlags[0]!.id,
          samePerson: true,
          note: 'Same.',
        }),
        resolveDuplicate(clientTwo, actor, {
          flagId: duplicateFlags[0]!.id,
          samePerson: false,
          note: 'Different.',
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    } finally {
      await Promise.all([clientOne.$disconnect(), clientTwo.$disconnect()]);
    }
  });

  it('does not flag two genuinely different people', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    await makeExpert({ email: 'one@example.test', fullName: 'Person One' });
    const result = await createCandidate(prisma, actor, {
      fullName: 'Someone Else Entirely',
      email: 'two@example.test',
    });
    expect(result.duplicateFlags).toEqual([]);
    expect(result.candidate.stage).toBe('NEW');
  });

  it('refuses to progress a person who opted out of contact', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const domain = await makeDomain();
    const { candidate } = await createCandidate(prisma, actor, {
      fullName: 'Opted Out',
      email: 'opted.out@example.test',
    });

    const { optOutCandidate } = await import('@/server/services/candidates');
    await optOutCandidate(prisma, actor, candidate.id, 'Asked not to be contacted.');

    await expectAppError(
      submitApplication(prisma, actor, { candidateId: candidate.id, domainId: domain.id }),
      'INVALID_STATE',
      /opted out/,
    );
  });
});

describe('a resubmission re-opens the reviewer who judged the previous revision', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('re-assigns the same reviewer instead of refusing them', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const domain = await makeDomain();
    const version = await makeRubricVersion(domain.id);
    const candidate = await makeCandidate();

    const screening = await startScreening(prisma, actorFor(admin), {
      candidateId: candidate.id,
      rubricVersionId: version.id,
    });
    await submitScreening(prisma, actorFor(admin), {
      screeningId: screening.id,
      answers: { depth: 'first attempt' },
    });

    const first = await assignReviewer(prisma, actorFor(admin), {
      screeningId: screening.id,
      reviewerId: admin.id,
    });
    await submitReview(prisma, actorFor(admin), {
      reviewId: first.id,
      decision: 'REQUEST_REVISION',
      publicFeedback: 'Add a link.',
      privateNotes: 'Internal only.',
    });

    // A second assignment against the same revision is still refused.
    await expect(
      assignReviewer(prisma, actorFor(admin), {
        screeningId: screening.id,
        reviewerId: admin.id,
      }),
    ).rejects.toThrow(/already reviewed this revision/);

    await requestRevision(prisma, actorFor(admin), {
      screeningId: screening.id,
      feedback: 'Please add the link.',
    });
    await submitScreening(prisma, actorFor(admin), {
      screeningId: screening.id,
      answers: { depth: 'second attempt', evidence: 'see link' },
      workSampleLinks: ['https://example.test/work'],
    });

    const reopened = await assignReviewer(prisma, actorFor(admin), {
      screeningId: screening.id,
      reviewerId: admin.id,
    });

    expect(reopened.id).toBe(first.id);
    expect(reopened.state).toBe('ASSIGNED');
    // The previous round's judgement no longer describes the current one.
    expect(reopened.decision).toBeNull();
    expect(reopened.privateNotes).toBe('');

    // It is kept in the history instead, so nothing is lost.
    const reopenEvents = await prisma.activityEvent.findMany({
      where: { entityId: screening.id, action: 'screening.review_reopened' },
    });
    expect(reopenEvents).toHaveLength(1);
    expect(reopenEvents[0]!.metadata).toMatchObject({ supersededDecision: 'REQUEST_REVISION' });

    // And the reviewer can now record a decision on the new revision.
    await submitReview(prisma, actorFor(admin), { reviewId: reopened.id, decision: 'APPROVE' });
    const stored = await prisma.screeningReview.findUniqueOrThrow({ where: { id: first.id } });
    expect(stored.decision).toBe('APPROVE');
  });
});
