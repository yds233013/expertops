import { type Prisma, type Qualification, type QualificationStatus } from '@prisma/client';
import { type Db, isPrismaErrorCode, PG_UNIQUE_VIOLATION } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, conflict, invalidState, notFound } from '@/lib/errors';
import { type Actor, recordActivity } from './activity';
import { enqueueJob } from './jobs';
import { createExpert } from './experts';
import { setCandidateStage } from './candidates';

/**
 * Qualifications: the record that a named human decided someone meets a
 * specific rubric version in a domain.
 *
 * Two rules shape everything here:
 *
 *  * **A qualification is evidence, not an assignment.** Being qualified makes
 *    someone *eligible*; it never places them on a project. Staffing keeps its
 *    own gates (verified onboarding, accepted invitation, declared capacity).
 *  * **Raising a project's bar surfaces work, it does not rewrite history.**
 *    Existing qualifications keep their rubric version and are marked
 *    NEEDS_REREVIEW, so a human decides rather than the system silently
 *    invalidating or approving anyone.
 */
export interface GrantQualificationInput {
  screeningId: string;
  /** Optional note recorded with the decision. */
  note?: string;
  /** Existing expert to attach to. Omitted means convert the candidate. */
  expertId?: string;
}

export interface GrantResult {
  qualification: Qualification;
  expertId: string;
  createdExpert: boolean;
}

/**
 * HUMAN DECISION. Approve a screening and record the qualification.
 *
 * Converts the candidate into a network expert if they are not one already.
 * That conversion is explicit and logged; nobody becomes an expert as a side
 * effect of submitting a form.
 */
export async function grantQualification(
  db: Db,
  actor: Actor,
  input: GrantQualificationInput,
): Promise<GrantResult> {
  const screening = await db.screening.findUnique({
    where: { id: input.screeningId },
    include: {
      candidate: true,
      rubricVersion: { include: { template: { include: { domain: true } } } },
      reviews: true,
      conflict: true,
      qualification: true,
    },
  });
  if (!screening) throw notFound('Screening not found.');

  if (screening.qualification) {
    throw conflict(`Screening ${screening.reference} already produced a qualification.`);
  }
  if (!['SUBMITTED', 'IN_REVIEW'].includes(screening.status)) {
    throw invalidState(
      `Screening ${screening.reference} is ${screening.status} and cannot be decided.`,
    );
  }
  const submittedReviews = screening.reviews.filter((review) => review.state === 'SUBMITTED');
  if (submittedReviews.length === 0) {
    throw invalidState(
      'A qualification needs at least one submitted human review. Assign a reviewer first.',
    );
  }
  if (screening.conflict && screening.conflict.status === 'OPEN') {
    throw invalidState(
      'Reviewers disagree on this screening. Resolve the conflict before granting a qualification.',
      { screeningId: screening.id },
    );
  }

  const at = clockNow();
  const domain = screening.rubricVersion.template.domain;

  // Resolve, or create, the expert record.
  let expertId = input.expertId ?? screening.candidate.expertId ?? null;
  let createdExpert = false;

  if (!expertId) {
    const existingByEmail = await db.expert.findUnique({
      where: { email: screening.candidate.email },
    });
    if (existingByEmail) {
      expertId = existingByEmail.id;
    } else {
      const expert = await createExpert(db, actor, {
        fullName: screening.candidate.fullName,
        email: screening.candidate.email,
        headline: screening.candidate.headline || `${domain.name} specialist`,
        yearsExperience: screening.candidate.yearsExperience,
        timezone: screening.candidate.timezone,
      });
      expertId = expert.id;
      createdExpert = true;
    }
    await db.candidate.update({
      where: { id: screening.candidateId },
      data: { expertId },
    });
  }

  // Claim the screening so two operators cannot both decide it.
  const claimed = await db.screening.updateMany({
    where: { id: screening.id, status: { in: ['SUBMITTED', 'IN_REVIEW'] } },
    data: {
      status: 'DECIDED',
      outcome: 'APPROVED',
      decidedAt: at,
      decidedById: actor.userId ?? null,
      decisionNote: input.note?.trim() ?? null,
    },
  });
  if (claimed.count === 0) {
    throw invalidState('This screening was decided by someone else.');
  }

  let qualification: Qualification;
  try {
    qualification = await db.qualification.create({
      data: {
        expertId,
        domainId: domain.id,
        rubricVersionId: screening.rubricVersionId,
        screeningId: screening.id,
        status: 'ACTIVE',
        decidedById: actor.userId ?? null,
        decidedAt: at,
        note: input.note?.trim() ?? '',
      },
    });
  } catch (error) {
    if (isPrismaErrorCode(error, PG_UNIQUE_VIOLATION)) {
      throw conflict(
        `This expert is already qualified in ${domain.name} against rubric v${screening.rubricVersion.version}.`,
      );
    }
    throw error;
  }

  await setCandidateStage(db, actor, screening.candidateId, 'QUALIFIED', { silent: true });

  await recordActivity(db, {
    actor,
    entityType: 'qualification',
    entityId: qualification.id,
    expertId,
    candidateId: screening.candidateId,
    action: 'qualification.granted',
    summary: `${actor.label} qualified ${screening.candidate.fullName} in ${domain.name} (rubric v${screening.rubricVersion.version})`,
    metadata: {
      screeningId: screening.id,
      rubricVersionId: screening.rubricVersionId,
      rubricVersion: screening.rubricVersion.version,
      reviewCount: submittedReviews.length,
      createdExpert,
      note: input.note?.trim() ?? null,
    },
  });

  await enqueueJob(db, {
    type: 'qualification.apply',
    payload: { qualificationId: qualification.id },
    priority: 30,
    dedupeKey: `qualification.apply:${qualification.id}`,
  });

  return { qualification, expertId, createdExpert };
}

/** HUMAN DECISION. Reject a screening. The candidate stays on file. */
export async function rejectScreening(
  db: Db,
  actor: Actor,
  input: { screeningId: string; note: string },
) {
  if (!input.note.trim()) throw badRequest('A reason is required when rejecting a screening.');

  const screening = await db.screening.findUnique({
    where: { id: input.screeningId },
    include: { candidate: true, reviews: true },
  });
  if (!screening) throw notFound('Screening not found.');
  if (!['SUBMITTED', 'IN_REVIEW'].includes(screening.status)) {
    throw invalidState(`Screening ${screening.reference} is ${screening.status}.`);
  }
  if (screening.reviews.filter((r) => r.state === 'SUBMITTED').length === 0) {
    throw invalidState('A rejection needs at least one submitted human review.');
  }

  const claimed = await db.screening.updateMany({
    where: { id: screening.id, status: { in: ['SUBMITTED', 'IN_REVIEW'] } },
    data: {
      status: 'DECIDED',
      outcome: 'REJECTED',
      decidedAt: clockNow(),
      decidedById: actor.userId ?? null,
      decisionNote: input.note.trim(),
    },
  });
  if (claimed.count === 0) throw invalidState('This screening was decided by someone else.');

  await setCandidateStage(db, actor, screening.candidateId, 'REJECTED', { silent: true });

  await recordActivity(db, {
    actor,
    entityType: 'screening',
    entityId: screening.id,
    candidateId: screening.candidateId,
    action: 'screening.rejected',
    summary: `${actor.label} did not qualify ${screening.candidate.fullName} (${screening.reference})`,
    metadata: { note: input.note.trim() },
  });

  return db.screening.findUniqueOrThrow({ where: { id: screening.id } });
}

export async function revokeQualification(
  db: Db,
  actor: Actor,
  input: { qualificationId: string; reason: string },
): Promise<Qualification> {
  if (!input.reason.trim()) throw badRequest('A reason is required to revoke a qualification.');

  const qualification = await db.qualification.findUnique({
    where: { id: input.qualificationId },
    include: { expert: true, domain: true },
  });
  if (!qualification) throw notFound('Qualification not found.');
  if (qualification.status === 'REVOKED') return qualification;

  const updated = await db.qualification.update({
    where: { id: input.qualificationId },
    data: {
      status: 'REVOKED',
      revokedAt: clockNow(),
      revokedById: actor.userId ?? null,
      note: `${qualification.note}\n[revoked] ${input.reason.trim()}`.trim(),
    },
  });

  await recordActivity(db, {
    actor,
    entityType: 'qualification',
    entityId: qualification.id,
    expertId: qualification.expertId,
    action: 'qualification.revoked',
    summary: `${actor.label} revoked ${qualification.expert.fullName}'s ${qualification.domain.name} qualification`,
    metadata: { reason: input.reason.trim() },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Project requirements
// ---------------------------------------------------------------------------

export interface SetRequirementInput {
  projectId: string;
  domainId: string;
  minRubricVersionId: string;
  isMandatory?: boolean;
}

export interface RequirementChangeResult {
  requirement: { id: string; projectId: string; domainId: string; minRubricVersionId: string };
  /** Qualifications now below the bar, flagged for a human to look at. */
  flaggedForRereview: number;
  affectedExpertIds: string[];
}

/**
 * Set what a project will accept.
 *
 * Raising the bar never revokes anything. Qualifications below the new minimum
 * are marked NEEDS_REREVIEW and surface as work; the people holding them keep
 * their record and their history exactly as decided.
 */
export async function setProjectQualificationRequirement(
  db: Db,
  actor: Actor,
  input: SetRequirementInput,
): Promise<RequirementChangeResult> {
  const project = await db.project.findUnique({ where: { id: input.projectId } });
  if (!project) throw notFound('Project not found.');

  const version = await db.screeningRubricVersion.findUnique({
    where: { id: input.minRubricVersionId },
    include: { template: { include: { domain: true } } },
  });
  if (!version) throw notFound('Rubric version not found.');
  if (version.status !== 'PUBLISHED') {
    throw invalidState('A project can only require a published rubric version.');
  }
  if (version.template.domainId !== input.domainId) {
    throw badRequest('That rubric version belongs to a different domain.');
  }

  const requirement = await db.projectQualificationRequirement.upsert({
    where: { projectId_domainId: { projectId: input.projectId, domainId: input.domainId } },
    update: {
      minRubricVersionId: input.minRubricVersionId,
      isMandatory: input.isMandatory ?? true,
    },
    create: {
      projectId: input.projectId,
      domainId: input.domainId,
      minRubricVersionId: input.minRubricVersionId,
      isMandatory: input.isMandatory ?? true,
    },
  });

  // Anyone qualified on an older version of this template now needs a look.
  const belowBar = await db.qualification.findMany({
    where: {
      domainId: input.domainId,
      status: 'ACTIVE',
      rubricVersion: { templateId: version.templateId, version: { lt: version.version } },
    },
    include: { expert: { select: { id: true, fullName: true } }, rubricVersion: true },
  });

  const affectedExpertIds: string[] = [];
  for (const qualification of belowBar) {
    await db.qualification.update({
      where: { id: qualification.id },
      data: {
        status: 'NEEDS_REREVIEW',
        rereviewReason: `Project ${project.code} now requires ${version.template.name} v${version.version}; this qualification is v${qualification.rubricVersion.version}.`,
      },
    });
    affectedExpertIds.push(qualification.expertId);
  }

  await recordActivity(db, {
    actor,
    entityType: 'project',
    entityId: input.projectId,
    projectId: input.projectId,
    action: 'project.qualification_requirement_set',
    summary: `${actor.label} set ${project.code} to require ${version.template.domain.name} rubric v${version.version} or newer`,
    metadata: {
      domainId: input.domainId,
      minRubricVersion: version.version,
      flaggedForRereview: belowBar.length,
      // Stated explicitly: nothing was revoked or auto-approved.
      revoked: 0,
      autoApproved: 0,
    },
  });

  return {
    requirement,
    flaggedForRereview: belowBar.length,
    affectedExpertIds,
  };
}

/** HUMAN DECISION. Confirm a flagged qualification still stands, or does not. */
export async function resolveRereview(
  db: Db,
  actor: Actor,
  input: { qualificationId: string; stillValid: boolean; note: string },
): Promise<Qualification> {
  if (!input.note.trim()) throw badRequest('A note is required when resolving a re-review.');

  const qualification = await db.qualification.findUnique({
    where: { id: input.qualificationId },
    include: { expert: true, domain: true },
  });
  if (!qualification) throw notFound('Qualification not found.');
  if (qualification.status !== 'NEEDS_REREVIEW') {
    throw invalidState(`This qualification is ${qualification.status}, not awaiting re-review.`);
  }

  const updated = await db.qualification.update({
    where: { id: input.qualificationId },
    data: {
      status: input.stillValid ? 'ACTIVE' : 'SUPERSEDED',
      rereviewReason: null,
      note: `${qualification.note}\n[re-review] ${input.note.trim()}`.trim(),
    },
  });

  await recordActivity(db, {
    actor,
    entityType: 'qualification',
    entityId: qualification.id,
    expertId: qualification.expertId,
    action: input.stillValid
      ? 'qualification.rereview_upheld'
      : 'qualification.rereview_superseded',
    summary: input.stillValid
      ? `${actor.label} confirmed ${qualification.expert.fullName}'s ${qualification.domain.name} qualification still stands`
      : `${actor.label} marked ${qualification.expert.fullName}'s ${qualification.domain.name} qualification superseded`,
    metadata: { note: input.note.trim() },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface EligibilityResult {
  eligible: boolean;
  /** Present when the expert cannot be considered for this project. */
  reason: string | null;
  satisfied: Array<{ domain: string; rubricVersion: number }>;
  missing: Array<{
    domain: string;
    requiredVersion: number;
    held: number | null;
    status: string | null;
  }>;
}

/**
 * Does this expert satisfy the project's qualification requirements?
 *
 * Answers only the qualification question. Staffing still applies its own
 * separate checks, which is the point: qualification is necessary but never
 * sufficient.
 */
export async function checkQualificationEligibility(
  db: Db,
  projectId: string,
  expertId: string,
): Promise<EligibilityResult> {
  const requirements = await db.projectQualificationRequirement.findMany({
    where: { projectId, isMandatory: true },
    include: {
      domain: true,
      minRubricVersion: { include: { template: true } },
    },
  });

  if (requirements.length === 0) {
    return { eligible: true, reason: null, satisfied: [], missing: [] };
  }

  const qualifications = await db.qualification.findMany({
    where: { expertId },
    include: { rubricVersion: true, domain: true },
  });

  const satisfied: EligibilityResult['satisfied'] = [];
  const missing: EligibilityResult['missing'] = [];

  for (const requirement of requirements) {
    const held = qualifications.filter(
      (qualification) =>
        qualification.domainId === requirement.domainId &&
        qualification.rubricVersion.templateId === requirement.minRubricVersion.templateId,
    );

    const usable = held.find(
      (qualification) =>
        qualification.status === 'ACTIVE' &&
        qualification.rubricVersion.version >= requirement.minRubricVersion.version,
    );

    if (usable) {
      satisfied.push({
        domain: requirement.domain.name,
        rubricVersion: usable.rubricVersion.version,
      });
      continue;
    }

    const best = held.sort((a, b) => b.rubricVersion.version - a.rubricVersion.version)[0];
    missing.push({
      domain: requirement.domain.name,
      requiredVersion: requirement.minRubricVersion.version,
      held: best?.rubricVersion.version ?? null,
      status: best?.status ?? null,
    });
  }

  if (missing.length === 0) {
    return { eligible: true, reason: null, satisfied, missing };
  }

  const reason = missing
    .map((item) =>
      item.held === null
        ? `no ${item.domain} qualification (needs v${item.requiredVersion}+)`
        : `${item.domain} qualification is v${item.held} (${item.status}), project needs v${item.requiredVersion}+`,
    )
    .join('; ');

  return { eligible: false, reason, satisfied, missing };
}

export async function listQualifications(
  db: Db,
  query: {
    expertId?: string;
    domainId?: string;
    status?: QualificationStatus;
    limit?: number;
  } = {},
) {
  const where: Prisma.QualificationWhereInput = {};
  if (query.expertId) where.expertId = query.expertId;
  if (query.domainId) where.domainId = query.domainId;
  if (query.status) where.status = query.status;

  return db.qualification.findMany({
    where,
    orderBy: [{ decidedAt: 'desc' }],
    take: Math.min(query.limit ?? 100, 300),
    include: {
      expert: { select: { id: true, reference: true, fullName: true, status: true } },
      domain: true,
      rubricVersion: { include: { template: true } },
      decidedBy: { select: { id: true, name: true } },
      screening: { select: { id: true, reference: true } },
    },
  });
}

export async function listDomains(db: Db) {
  return db.domain.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    include: { _count: { select: { qualifications: true, templates: true } } },
  });
}
