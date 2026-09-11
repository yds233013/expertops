import {
  type Prisma,
  type ReviewDecision,
  type Screening,
  type ScreeningRubricVersion,
  type ScreeningStatus,
} from '@prisma/client';
import { type Db, isPrismaErrorCode, PG_UNIQUE_VIOLATION } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, conflict, forbidden, invalidState, notFound } from '@/lib/errors';
import { formatReference, parseReferenceSequence, slugify } from '@/lib/ids';
import { hoursFromNow } from '@/lib/time';
import { type Actor, recordActivity } from './activity';
import { enqueueJob } from './jobs';
import { setCandidateStage, validateWorkSampleLink } from './candidates';

/**
 * Domain screening.
 *
 * The central rule: a **published rubric version is immutable**. Editing a
 * published rubric creates a new version; screenings keep the version they were
 * started against. That is what makes a decision from three months ago still
 * explainable, and it is why raising a project's bar produces re-review work
 * rather than silently invalidating people.
 */
export const SCREENING_REFERENCE_PREFIX = 'SCR';

async function nextScreeningReference(db: Db): Promise<string> {
  const latest = await db.screening.findFirst({
    orderBy: { reference: 'desc' },
    select: { reference: true },
  });
  return formatReference(
    SCREENING_REFERENCE_PREFIX,
    parseReferenceSequence(SCREENING_REFERENCE_PREFIX, latest?.reference) + 1,
  );
}

// ---------------------------------------------------------------------------
// Templates and rubric versions
// ---------------------------------------------------------------------------

export interface CriterionInput {
  key: string;
  label: string;
  scoringGuidance?: string;
  maxScore?: number;
  weight?: number;
  requiredEvidence?: 'NONE' | 'WORK_SAMPLE_LINK' | 'WRITTEN_ANSWER' | 'REFERENCE_STATEMENT';
  isGating?: boolean;
}

function validateCriteria(criteria: CriterionInput[]) {
  if (criteria.length === 0) throw badRequest('A rubric needs at least one criterion.');
  const seen = new Set<string>();
  return criteria.map((criterion, index) => {
    const key = slugify(criterion.key || criterion.label);
    if (!key) throw badRequest('Each criterion needs a key.');
    if (seen.has(key)) throw badRequest(`Criterion "${key}" is listed twice.`);
    seen.add(key);

    const maxScore = criterion.maxScore ?? 5;
    if (!Number.isInteger(maxScore) || maxScore < 1 || maxScore > 10) {
      throw badRequest(`Max score for "${key}" must be between 1 and 10.`);
    }
    const weight = criterion.weight ?? 1;
    if (!Number.isInteger(weight) || weight < 1 || weight > 10) {
      throw badRequest(`Weight for "${key}" must be between 1 and 10.`);
    }
    return {
      key,
      label: criterion.label.trim(),
      scoringGuidance: criterion.scoringGuidance?.trim() ?? '',
      maxScore,
      weight,
      requiredEvidence: criterion.requiredEvidence ?? 'NONE',
      isGating: criterion.isGating ?? false,
      position: index,
    };
  });
}

export async function createTemplate(
  db: Db,
  actor: Actor,
  input: { name: string; domainId: string; description?: string },
) {
  const slug = slugify(input.name);
  if (!slug) throw badRequest('Template name cannot be blank.');

  const domain = await db.domain.findUnique({ where: { id: input.domainId } });
  if (!domain) throw notFound('Domain not found.');

  try {
    const template = await db.screeningTemplate.create({
      data: {
        slug,
        name: input.name.trim(),
        domainId: input.domainId,
        description: input.description?.trim() ?? '',
      },
    });
    await recordActivity(db, {
      actor,
      entityType: 'rubric',
      entityId: template.id,
      action: 'rubric.template_created',
      summary: `Screening template "${template.name}" created for ${domain.name}`,
    });
    return template;
  } catch (error) {
    if (isPrismaErrorCode(error, PG_UNIQUE_VIOLATION)) {
      throw conflict(`A screening template named "${input.name}" already exists.`);
    }
    throw error;
  }
}

/**
 * Start a new draft version.
 *
 * When a published version exists, its criteria are copied so an editor starts
 * from what is live rather than a blank page.
 */
export async function createDraftVersion(
  db: Db,
  actor: Actor,
  input: {
    templateId: string;
    criteria?: CriterionInput[];
    passThreshold?: number;
    guidance?: string;
    changeNote?: string;
  },
): Promise<ScreeningRubricVersion> {
  const template = await db.screeningTemplate.findUnique({
    where: { id: input.templateId },
    include: {
      versions: {
        orderBy: { version: 'desc' },
        take: 1,
        include: { criteria: { orderBy: { position: 'asc' } } },
      },
    },
  });
  if (!template) throw notFound('Screening template not found.');

  const latest = template.versions[0];
  if (latest && latest.status === 'DRAFT') {
    throw conflict(
      `Version ${latest.version} of this template is still a draft. Publish or discard it first.`,
      { draftVersionId: latest.id },
    );
  }

  const criteria = input.criteria
    ? validateCriteria(input.criteria)
    : (latest?.criteria ?? []).map((criterion, index) => ({
        key: criterion.key,
        label: criterion.label,
        scoringGuidance: criterion.scoringGuidance,
        maxScore: criterion.maxScore,
        weight: criterion.weight,
        requiredEvidence: criterion.requiredEvidence,
        isGating: criterion.isGating,
        position: index,
      }));

  if (criteria.length === 0) throw badRequest('A rubric needs at least one criterion.');

  const version = await db.screeningRubricVersion.create({
    data: {
      templateId: input.templateId,
      version: (latest?.version ?? 0) + 1,
      status: 'DRAFT',
      passThreshold: input.passThreshold ?? latest?.passThreshold ?? 0,
      guidance: input.guidance?.trim() ?? latest?.guidance ?? '',
      changeNote: input.changeNote?.trim() ?? '',
      createdById: actor.userId ?? null,
      criteria: { create: criteria },
    },
    include: { criteria: true },
  });

  await recordActivity(db, {
    actor,
    entityType: 'rubric',
    entityId: version.id,
    action: 'rubric.version_drafted',
    summary: `Drafted version ${version.version} of "${template.name}"`,
    metadata: { templateId: template.id, criteria: criteria.length },
  });
  return version;
}

/** Draft versions are editable. Published ones are not, and say so. */
export async function updateDraftVersion(
  db: Db,
  actor: Actor,
  versionId: string,
  input: {
    criteria?: CriterionInput[];
    passThreshold?: number;
    guidance?: string;
    changeNote?: string;
  },
): Promise<ScreeningRubricVersion> {
  const version = await db.screeningRubricVersion.findUnique({
    where: { id: versionId },
    include: { template: true },
  });
  if (!version) throw notFound('Rubric version not found.');
  if (version.status !== 'DRAFT') {
    throw invalidState(
      `Version ${version.version} is ${version.status} and is immutable. Create a new version to change the criteria.`,
      { versionId, status: version.status },
    );
  }

  if (input.criteria) {
    const criteria = validateCriteria(input.criteria);
    await db.rubricCriterion.deleteMany({ where: { rubricVersionId: versionId } });
    await db.rubricCriterion.createMany({
      data: criteria.map((criterion) => ({ ...criterion, rubricVersionId: versionId })),
    });
  }

  const updated = await db.screeningRubricVersion.update({
    where: { id: versionId },
    data: {
      passThreshold: input.passThreshold ?? version.passThreshold,
      guidance: input.guidance?.trim() ?? version.guidance,
      changeNote: input.changeNote?.trim() ?? version.changeNote,
    },
  });

  await recordActivity(db, {
    actor,
    entityType: 'rubric',
    entityId: versionId,
    action: 'rubric.draft_updated',
    summary: `Draft version ${version.version} of "${version.template.name}" updated`,
  });
  return updated;
}

/**
 * Publish a draft. From here the version can never change.
 *
 * Publishing does not touch existing qualifications: raising the bar is a
 * separate, explicit act on the project that needs the higher bar.
 */
export async function publishVersion(
  db: Db,
  actor: Actor,
  versionId: string,
): Promise<ScreeningRubricVersion> {
  const version = await db.screeningRubricVersion.findUnique({
    where: { id: versionId },
    include: { template: true, criteria: true },
  });
  if (!version) throw notFound('Rubric version not found.');
  if (version.status !== 'DRAFT') {
    throw invalidState(`Version ${version.version} is already ${version.status}.`);
  }
  if (version.criteria.length === 0) {
    throw invalidState('A rubric cannot be published with no criteria.');
  }

  const at = clockNow();
  const claimed = await db.screeningRubricVersion.updateMany({
    where: { id: versionId, status: 'DRAFT' },
    data: { status: 'PUBLISHED', publishedAt: at, publishedById: actor.userId ?? null },
  });
  if (claimed.count === 0) {
    throw invalidState('This version was published by someone else.');
  }

  await recordActivity(db, {
    actor,
    entityType: 'rubric',
    entityId: versionId,
    action: 'rubric.published',
    summary: `${actor.label} published version ${version.version} of "${version.template.name}"`,
    metadata: {
      templateId: version.templateId,
      version: version.version,
      criteria: version.criteria.length,
      immutable: true,
    },
  });

  return db.screeningRubricVersion.findUniqueOrThrow({ where: { id: versionId } });
}

export async function latestPublishedVersion(db: Db, templateId: string) {
  return db.screeningRubricVersion.findFirst({
    where: { templateId, status: 'PUBLISHED' },
    orderBy: { version: 'desc' },
    include: {
      criteria: { orderBy: { position: 'asc' } },
      template: { include: { domain: true } },
    },
  });
}

export async function listTemplates(db: Db, domainId?: string) {
  return db.screeningTemplate.findMany({
    where: { isActive: true, ...(domainId ? { domainId } : {}) },
    orderBy: { name: 'asc' },
    include: {
      domain: true,
      versions: {
        orderBy: { version: 'desc' },
        include: {
          criteria: { orderBy: { position: 'asc' } },
          _count: { select: { screenings: true } },
        },
      },
    },
  });
}

export async function getRubricVersion(db: Db, versionId: string) {
  const version = await db.screeningRubricVersion.findUnique({
    where: { id: versionId },
    include: {
      criteria: { orderBy: { position: 'asc' } },
      template: { include: { domain: true } },
      publishedBy: { select: { id: true, name: true } },
    },
  });
  if (!version) throw notFound('Rubric version not found.');
  return version;
}

// ---------------------------------------------------------------------------
// Screenings
// ---------------------------------------------------------------------------

export const DEFAULT_SCREENING_TTL_HOURS = 168; // one week
export const DEFAULT_REVIEW_TTL_HOURS = 72;

export interface StartScreeningInput {
  candidateId: string;
  rubricVersionId: string;
  dueInHours?: number;
}

/**
 * Invite a candidate to a screening.
 *
 * This is intake assessment, and is deliberately a different thing from
 * inviting an already-qualified expert onto a project. The two never share a
 * code path: one produces a Screening, the other an Invitation.
 */
export async function startScreening(
  db: Db,
  actor: Actor,
  input: StartScreeningInput,
): Promise<Screening> {
  const candidate = await db.candidate.findUnique({ where: { id: input.candidateId } });
  if (!candidate) throw notFound('Candidate not found.');
  if (candidate.contactOptOutAt) {
    throw invalidState(`${candidate.fullName} has opted out of contact.`);
  }
  if (candidate.stage === 'DUPLICATE_HOLD') {
    throw invalidState(
      'This candidate is on hold pending a duplicate-person decision. Resolve that first.',
    );
  }
  if (candidate.stage === 'WITHDRAWN' || candidate.stage === 'REJECTED') {
    throw invalidState(`Candidate is ${candidate.stage} and cannot be screened.`);
  }

  const version = await db.screeningRubricVersion.findUnique({
    where: { id: input.rubricVersionId },
    include: { template: { include: { domain: true } } },
  });
  if (!version) throw notFound('Rubric version not found.');
  if (version.status !== 'PUBLISHED') {
    throw invalidState('Screenings can only run against a published rubric version.');
  }

  const open = await db.screening.findFirst({
    where: {
      candidateId: input.candidateId,
      status: { in: ['INVITED', 'SUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED'] },
    },
  });
  if (open) {
    throw conflict(`${candidate.fullName} already has an open screening (${open.reference}).`, {
      screeningId: open.id,
    });
  }

  const ttl = input.dueInHours ?? DEFAULT_SCREENING_TTL_HOURS;
  if (ttl < 1 || ttl > 24 * 90) throw badRequest('Screening window must be 1 hour to 90 days.');

  const screening = await db.screening.create({
    data: {
      reference: await nextScreeningReference(db),
      candidateId: input.candidateId,
      rubricVersionId: input.rubricVersionId,
      status: 'INVITED',
      invitedAt: clockNow(),
      dueAt: hoursFromNow(ttl, clockNow()),
      createdById: actor.userId ?? null,
    },
  });

  await setCandidateStage(db, actor, input.candidateId, 'SCREENING_INVITED', {
    reason: `screening ${screening.reference} opened`,
    silent: true,
  });

  await recordActivity(db, {
    actor,
    entityType: 'screening',
    entityId: screening.id,
    candidateId: input.candidateId,
    action: 'screening.invited',
    summary: `${candidate.fullName} invited to screening ${screening.reference} (${version.template.domain.name}, rubric v${version.version})`,
    metadata: {
      rubricVersionId: version.id,
      rubricVersion: version.version,
      dueAt: screening.dueAt.toISOString(),
    },
  });

  await enqueueJob(db, {
    type: 'screening.invite',
    payload: { screeningId: screening.id },
    priority: 20,
    dedupeKey: `screening.invite:${screening.id}:${screening.currentRevision}`,
  });

  return screening;
}

export interface SubmitScreeningInput {
  screeningId: string;
  answers: Record<string, string>;
  workSampleLinks?: string[];
  note?: string;
}

export interface SubmissionResult {
  screening: Screening;
  isComplete: boolean;
  missingEvidence: string[];
  revision: number;
}

/**
 * A candidate submits their screening.
 *
 * An incomplete submission is accepted and recorded as incomplete rather than
 * rejected. That is deliberate: the operator needs to see what was attempted,
 * and a reviewer may still be able to act on it.
 */
export async function submitScreening(
  db: Db,
  actor: Actor,
  input: SubmitScreeningInput,
): Promise<SubmissionResult> {
  const screening = await db.screening.findUnique({
    where: { id: input.screeningId },
    include: {
      candidate: true,
      rubricVersion: { include: { criteria: { orderBy: { position: 'asc' } } } },
    },
  });
  if (!screening) throw notFound('Screening not found.');

  if (!['INVITED', 'REVISION_REQUESTED'].includes(screening.status)) {
    throw invalidState(
      `Screening ${screening.reference} is ${screening.status} and is not accepting submissions.`,
    );
  }
  if (screening.dueAt.getTime() <= clockNow().getTime()) {
    throw invalidState('The submission window for this screening has closed.');
  }

  const links = (input.workSampleLinks ?? []).slice(0, 10).map(validateWorkSampleLink);

  // Work out which required evidence is missing without blocking the submission.
  const missingEvidence: string[] = [];
  for (const criterion of screening.rubricVersion.criteria) {
    const answer = (input.answers[criterion.key] ?? '').trim();
    if (criterion.requiredEvidence === 'NONE') continue;
    if (criterion.requiredEvidence === 'WORK_SAMPLE_LINK' && links.length === 0) {
      missingEvidence.push(`${criterion.label}: a work sample link is required`);
      continue;
    }
    if (
      (criterion.requiredEvidence === 'WRITTEN_ANSWER' ||
        criterion.requiredEvidence === 'REFERENCE_STATEMENT') &&
      answer.length === 0
    ) {
      missingEvidence.push(`${criterion.label}: a written response is required`);
    }
  }

  const revision = screening.currentRevision + 1;
  const at = clockNow();

  await db.screeningSubmission.create({
    data: {
      screeningId: screening.id,
      revision,
      answers: input.answers as Prisma.InputJsonValue,
      workSampleLinks: links as Prisma.InputJsonValue,
      note: input.note?.trim() ?? '',
      isComplete: missingEvidence.length === 0,
      missingEvidence: missingEvidence as Prisma.InputJsonValue,
      submittedAt: at,
    },
  });

  const updated = await db.screening.update({
    where: { id: screening.id },
    data: {
      status: 'SUBMITTED',
      submittedAt: at,
      currentRevision: revision,
      reviewDueAt: hoursFromNow(DEFAULT_REVIEW_TTL_HOURS, at),
    },
  });

  await setCandidateStage(db, actor, screening.candidateId, 'SCREENING_SUBMITTED', {
    silent: true,
  });

  await recordActivity(db, {
    actor,
    entityType: 'screening',
    entityId: screening.id,
    candidateId: screening.candidateId,
    action: 'screening.submitted',
    summary: missingEvidence.length
      ? `${screening.candidate.fullName} submitted screening ${screening.reference} with ${missingEvidence.length} item(s) of evidence missing`
      : `${screening.candidate.fullName} submitted screening ${screening.reference}`,
    metadata: { revision, isComplete: missingEvidence.length === 0, missingEvidence },
  });

  // Assigning a reviewer is automatic; failing to find one is an exception,
  // not a silent stall. Both are handled by the job.
  await enqueueJob(db, {
    type: 'screening.assign_reviewer',
    payload: { screeningId: screening.id },
    priority: 25,
    dedupeKey: `screening.assign_reviewer:${screening.id}:${revision}`,
  });

  return {
    screening: updated,
    isComplete: missingEvidence.length === 0,
    missingEvidence,
    revision,
  };
}

/** Assign a human reviewer. Idempotent per (screening, reviewer). */
export async function assignReviewer(
  db: Db,
  actor: Actor,
  input: { screeningId: string; reviewerId: string; dueInHours?: number },
) {
  const screening = await db.screening.findUnique({
    where: { id: input.screeningId },
    include: { candidate: true },
  });
  if (!screening) throw notFound('Screening not found.');
  if (!['SUBMITTED', 'IN_REVIEW'].includes(screening.status)) {
    throw invalidState(
      `Screening ${screening.reference} is ${screening.status}; a reviewer can only be assigned after submission.`,
    );
  }

  const reviewer = await db.user.findUnique({ where: { id: input.reviewerId } });
  if (!reviewer) throw notFound('Reviewer not found.');
  if (!reviewer.isActive) throw invalidState('That operator account is deactivated.');

  const submission = await db.screeningSubmission.findFirst({
    where: { screeningId: screening.id },
    orderBy: { revision: 'desc' },
  });

  const dueAt = hoursFromNow(input.dueInHours ?? DEFAULT_REVIEW_TTL_HOURS, clockNow());

  try {
    const review = await db.screeningReview.create({
      data: {
        screeningId: screening.id,
        reviewerId: input.reviewerId,
        submissionId: submission?.id ?? null,
        state: 'ASSIGNED',
        dueAt,
      },
    });

    await db.screening.update({
      where: { id: screening.id },
      data: { status: 'IN_REVIEW', reviewDueAt: dueAt },
    });
    await setCandidateStage(db, actor, screening.candidateId, 'IN_REVIEW', { silent: true });

    await recordActivity(db, {
      actor,
      entityType: 'screening',
      entityId: screening.id,
      candidateId: screening.candidateId,
      action: 'screening.reviewer_assigned',
      summary: `${reviewer.name} assigned to review ${screening.reference}`,
      metadata: { reviewerId: reviewer.id, dueAt: dueAt.toISOString() },
    });

    return review;
  } catch (error) {
    if (isPrismaErrorCode(error, PG_UNIQUE_VIOLATION)) {
      throw conflict(`${reviewer.name} is already reviewing ${screening.reference}.`);
    }
    throw error;
  }
}

export interface SubmitReviewInput {
  reviewId: string;
  decision: ReviewDecision;
  scores?: Record<string, number>;
  publicFeedback?: string;
  privateNotes?: string;
}

/**
 * HUMAN DECISION. A reviewer records their assessment.
 *
 * `privateNotes` are operator-only and are never included in any candidate- or
 * expert-facing payload. Requesting a revision requires feedback the candidate
 * can actually act on.
 */
export async function submitReview(db: Db, actor: Actor, input: SubmitReviewInput) {
  const review = await db.screeningReview.findUnique({
    where: { id: input.reviewId },
    include: {
      screening: {
        include: { candidate: true, rubricVersion: { include: { criteria: true } } },
      },
      reviewer: true,
    },
  });
  if (!review) throw notFound('Review not found.');
  if (review.reviewerId !== actor.userId) {
    throw forbidden('Only the assigned reviewer can submit this review.');
  }
  if (review.state !== 'ASSIGNED') {
    throw invalidState('This review has already been submitted or withdrawn.');
  }
  if (input.decision === 'REQUEST_REVISION' && !input.publicFeedback?.trim()) {
    throw badRequest('Requesting a revision requires feedback the candidate can act on.');
  }

  // Scores must reference real criteria and stay within range.
  const byKey = new Map(review.screening.rubricVersion.criteria.map((c) => [c.key, c]));
  for (const [key, value] of Object.entries(input.scores ?? {})) {
    const criterion = byKey.get(key);
    if (!criterion) throw badRequest(`Unknown rubric criterion "${key}".`);
    if (!Number.isInteger(value) || value < 0 || value > criterion.maxScore) {
      throw badRequest(
        `Score for "${criterion.label}" must be between 0 and ${criterion.maxScore}.`,
      );
    }
  }

  const at = clockNow();
  const claimed = await db.screeningReview.updateMany({
    where: { id: input.reviewId, state: 'ASSIGNED' },
    data: {
      state: 'SUBMITTED',
      decision: input.decision,
      scores: (input.scores ?? {}) as Prisma.InputJsonValue,
      publicFeedback: input.publicFeedback?.trim() ?? '',
      privateNotes: input.privateNotes?.trim() ?? '',
      submittedAt: at,
    },
  });
  if (claimed.count === 0) {
    throw invalidState('This review was already submitted.');
  }

  await recordActivity(db, {
    actor,
    entityType: 'screening',
    entityId: review.screeningId,
    candidateId: review.screening.candidateId,
    action: 'screening.review_submitted',
    summary: `${review.reviewer.name} recorded ${input.decision} on ${review.screening.reference}`,
    // Private notes never enter the activity summary or metadata.
    metadata: { decision: input.decision, reviewId: review.id },
  });

  return detectReviewConflict(db, review.screeningId);
}

/**
 * Compare submitted reviews and raise a conflict when they disagree.
 *
 * The system never breaks a tie. A conflict becomes a task for an authorised
 * operator, because "two qualified people disagreed" is exactly the situation
 * that needs judgement rather than arithmetic.
 */
export async function detectReviewConflict(db: Db, screeningId: string) {
  const reviews = await db.screeningReview.findMany({
    where: { screeningId, state: 'SUBMITTED' },
    include: { reviewer: { select: { id: true, name: true } } },
  });

  const decisions = new Set(reviews.map((review) => review.decision));
  if (reviews.length < 2 || decisions.size < 2) {
    return { conflict: null, reviews };
  }

  const summary = reviews
    .map((review) => `${review.reviewer.name}: ${review.decision}`)
    .join(' vs ');

  const existing = await db.reviewConflict.findUnique({ where: { screeningId } });
  const conflictRecord = existing
    ? await db.reviewConflict.update({ where: { screeningId }, data: { summary } })
    : await db.reviewConflict.create({
        data: { screeningId, summary, status: 'OPEN' },
      });

  return { conflict: conflictRecord, reviews };
}

/** HUMAN DECISION. Resolve a reviewer disagreement. */
export async function resolveConflict(
  db: Db,
  actor: Actor,
  input: { screeningId: string; resolution: ReviewDecision; note: string },
) {
  if (!input.note.trim()) throw badRequest('A note explaining the resolution is required.');

  const conflictRecord = await db.reviewConflict.findUnique({
    where: { screeningId: input.screeningId },
    include: { screening: { include: { candidate: true } } },
  });
  if (!conflictRecord) throw notFound('No review conflict for that screening.');
  if (conflictRecord.status !== 'OPEN') {
    throw invalidState('This conflict was already resolved.');
  }

  const claimed = await db.reviewConflict.updateMany({
    where: { screeningId: input.screeningId, status: 'OPEN' },
    data: {
      status: 'RESOLVED',
      resolution: input.resolution,
      resolvedById: actor.userId ?? null,
      resolvedAt: clockNow(),
      note: input.note.trim(),
    },
  });
  if (claimed.count === 0) throw invalidState('This conflict was resolved by someone else.');

  await recordActivity(db, {
    actor,
    entityType: 'screening',
    entityId: input.screeningId,
    candidateId: conflictRecord.screening.candidateId,
    action: 'screening.conflict_resolved',
    summary: `${actor.label} resolved conflicting reviews on ${conflictRecord.screening.reference} as ${input.resolution}`,
    metadata: { resolution: input.resolution, note: input.note.trim() },
  });

  return db.reviewConflict.findUniqueOrThrow({ where: { screeningId: input.screeningId } });
}

/** Request changes from the candidate, reopening the submission window. */
export async function requestRevision(
  db: Db,
  actor: Actor,
  input: { screeningId: string; feedback: string; extraHours?: number },
): Promise<Screening> {
  if (!input.feedback.trim()) throw badRequest('Revision feedback is required.');

  const screening = await db.screening.findUnique({
    where: { id: input.screeningId },
    include: { candidate: true },
  });
  if (!screening) throw notFound('Screening not found.');
  if (!['SUBMITTED', 'IN_REVIEW'].includes(screening.status)) {
    throw invalidState(`Screening ${screening.reference} is ${screening.status}.`);
  }

  const updated = await db.screening.update({
    where: { id: input.screeningId },
    data: {
      status: 'REVISION_REQUESTED',
      dueAt: hoursFromNow(input.extraHours ?? 72, clockNow()),
      reviewDueAt: null,
    },
  });
  await setCandidateStage(db, actor, screening.candidateId, 'REVISION_REQUESTED', { silent: true });

  await recordActivity(db, {
    actor,
    entityType: 'screening',
    entityId: input.screeningId,
    candidateId: screening.candidateId,
    action: 'screening.revision_requested',
    summary: `${actor.label} asked ${screening.candidate.fullName} to revise ${screening.reference}`,
    metadata: { feedback: input.feedback.trim() },
  });

  return updated;
}

export async function expireOverdueScreenings(
  db: Db,
  options: { now?: Date; limit?: number } = {},
) {
  const at = options.now ?? clockNow();
  const candidates = await db.screening.findMany({
    where: { status: { in: ['INVITED', 'REVISION_REQUESTED'] }, dueAt: { lte: at } },
    take: options.limit ?? 100,
    include: { candidate: true },
  });

  const expired: string[] = [];
  for (const screening of candidates) {
    const claimed = await db.screening.updateMany({
      where: { id: screening.id, status: { in: ['INVITED', 'REVISION_REQUESTED'] } },
      data: { status: 'EXPIRED' },
    });
    if (claimed.count === 0) continue;
    expired.push(screening.id);

    await recordActivity(db, {
      actor: { type: 'SYSTEM', label: 'ExpertOps worker' },
      entityType: 'screening',
      entityId: screening.id,
      candidateId: screening.candidateId,
      action: 'screening.expired',
      summary: `Screening ${screening.reference} expired without a submission`,
      metadata: { automated: true, dueAt: screening.dueAt.toISOString() },
    });
  }
  return { expiredCount: expired.length, screeningIds: expired };
}

export async function getScreening(db: Db, screeningId: string) {
  const screening = await db.screening.findUnique({
    where: { id: screeningId },
    include: {
      candidate: true,
      rubricVersion: {
        include: {
          criteria: { orderBy: { position: 'asc' } },
          template: { include: { domain: true } },
        },
      },
      submissions: { orderBy: { revision: 'desc' } },
      reviews: { include: { reviewer: { select: { id: true, name: true, email: true } } } },
      conflict: { include: { resolvedBy: { select: { id: true, name: true } } } },
      decidedBy: { select: { id: true, name: true } },
      qualification: true,
    },
  });
  if (!screening) throw notFound('Screening not found.');
  return screening;
}

export async function listScreenings(
  db: Db,
  query: {
    status?: ScreeningStatus;
    reviewerId?: string;
    overdueOnly?: boolean;
    limit?: number;
  } = {},
) {
  const where: Prisma.ScreeningWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.reviewerId)
    where.reviews = { some: { reviewerId: query.reviewerId, state: 'ASSIGNED' } };
  if (query.overdueOnly) {
    where.reviewDueAt = { lte: clockNow() };
    where.status = 'IN_REVIEW';
  }

  return db.screening.findMany({
    where,
    orderBy: [{ reviewDueAt: 'asc' }, { createdAt: 'desc' }],
    take: Math.min(query.limit ?? 50, 200),
    include: {
      candidate: {
        select: { id: true, reference: true, fullName: true, email: true, stage: true },
      },
      rubricVersion: { include: { template: { include: { domain: true } } } },
      reviews: { include: { reviewer: { select: { id: true, name: true } } } },
      conflict: true,
      submissions: { orderBy: { revision: 'desc' }, take: 1 },
    },
  });
}

/**
 * The candidate-facing view of a screening.
 *
 * Built by explicit field selection rather than by deleting keys from the full
 * record, so a future column cannot leak by being forgotten. Private reviewer
 * notes are structurally absent.
 */
export async function getScreeningForCandidate(db: Db, screeningId: string, candidateId: string) {
  const screening = await db.screening.findUnique({
    where: { id: screeningId },
    include: {
      rubricVersion: {
        include: {
          criteria: { orderBy: { position: 'asc' } },
          template: { include: { domain: true } },
        },
      },
      submissions: { orderBy: { revision: 'desc' } },
      reviews: { select: { decision: true, publicFeedback: true, submittedAt: true, state: true } },
    },
  });
  if (!screening || screening.candidateId !== candidateId) throw notFound('Screening not found.');

  return {
    id: screening.id,
    reference: screening.reference,
    status: screening.status,
    dueAt: screening.dueAt,
    submittedAt: screening.submittedAt,
    currentRevision: screening.currentRevision,
    domain: screening.rubricVersion.template.domain.name,
    rubricVersion: screening.rubricVersion.version,
    guidance: screening.rubricVersion.guidance,
    criteria: screening.rubricVersion.criteria.map((criterion) => ({
      key: criterion.key,
      label: criterion.label,
      scoringGuidance: criterion.scoringGuidance,
      requiredEvidence: criterion.requiredEvidence,
      maxScore: criterion.maxScore,
    })),
    submissions: screening.submissions.map((submission) => ({
      revision: submission.revision,
      submittedAt: submission.submittedAt,
      isComplete: submission.isComplete,
      missingEvidence: submission.missingEvidence,
    })),
    // Only feedback deliberately marked public is included.
    feedback: screening.reviews
      .filter((review) => review.state === 'SUBMITTED' && review.publicFeedback)
      .map((review) => ({ feedback: review.publicFeedback, submittedAt: review.submittedAt })),
  };
}
