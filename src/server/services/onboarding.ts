import { type OnboardingCase, type OnboardingItemKind, type Prisma } from '@prisma/client';
import { type Db } from '@/lib/db';
import { badRequest, invalidState, notFound } from '@/lib/errors';
import { assertTransition, ONBOARDING_TRANSITIONS } from '@/server/domain/state-machines';
import { type Actor, recordActivity } from './activity';
import { setExpertStatus } from './experts';

/**
 * Onboarding checklist.
 *
 * The checklist is a fixed template of professional/compliance attestations.
 * It deliberately contains no protected personal attributes - no age, health,
 * nationality, citizenship, family status, or similar. Everything asked for is
 * about the working engagement.
 */
export interface ChecklistItemTemplate {
  key: string;
  label: string;
  helpText: string;
  kind: OnboardingItemKind;
  required: boolean;
}

export const ONBOARDING_CHECKLIST: readonly ChecklistItemTemplate[] = [
  {
    key: 'profile_confirmed',
    label: 'Confirm your profile is accurate',
    helpText: 'Your headline, skills, seniority and rate as recorded by ExpertOps are correct.',
    kind: 'ATTESTATION',
    required: true,
  },
  {
    key: 'nda_accepted',
    label: 'Accept the mutual non-disclosure terms',
    helpText:
      'Standard confidentiality terms covering client material shared during an engagement.',
    kind: 'ATTESTATION',
    required: true,
  },
  {
    key: 'conflict_check',
    label: 'Declare any conflicts of interest',
    helpText:
      'List current or recent engagements that could conflict with this client, or write "None".',
    kind: 'TEXT',
    required: true,
  },
  {
    key: 'engagement_terms',
    label: 'Accept the engagement terms',
    helpText: 'Rates, invoicing cadence and notice period for ExpertOps engagements.',
    kind: 'ATTESTATION',
    required: true,
  },
  {
    key: 'billing_reference',
    label: 'Billing reference',
    helpText:
      'Internal billing reference supplied by your ExpertOps contact. Simulated in this build - no payment details are collected or stored.',
    kind: 'REFERENCE',
    required: true,
  },
  {
    key: 'working_notes',
    label: 'Working preferences (optional)',
    helpText: 'Anything the staffing team should know about your working hours or constraints.',
    kind: 'TEXT',
    required: false,
  },
] as const;

const CHECKLIST_BY_KEY = new Map(ONBOARDING_CHECKLIST.map((item) => [item.key, item]));

/**
 * Create the case + checklist if the expert has none.
 *
 * Idempotent: calling it twice (for example from a retried job) returns the
 * existing case rather than duplicating items.
 */
export async function ensureOnboardingCase(db: Db, expertId: string): Promise<OnboardingCase> {
  const existing = await db.onboardingCase.findUnique({ where: { expertId } });
  if (existing) return existing;

  return db.onboardingCase.create({
    data: {
      expertId,
      status: 'NOT_STARTED',
      items: {
        create: ONBOARDING_CHECKLIST.map((item, index) => ({
          key: item.key,
          label: item.label,
          helpText: item.helpText,
          kind: item.kind,
          required: item.required,
          position: index,
        })),
      },
    },
  });
}

/**
 * Move an expert into onboarding after they accept an invitation.
 *
 * Called by the invitation service and by the worker's `onboarding.start` job.
 */
export async function startOnboarding(
  db: Db,
  actor: Actor,
  expertId: string,
): Promise<OnboardingCase> {
  const expert = await db.expert.findUnique({ where: { id: expertId } });
  if (!expert) throw notFound('Expert not found.');

  const onboardingCase = await ensureOnboardingCase(db, expertId);

  if (expert.status === 'PROSPECT' || expert.status === 'REJECTED') {
    await setExpertStatus(db, actor, expertId, 'ONBOARDING', { reason: 'invitation accepted' });
  }

  if (onboardingCase.status === 'NOT_STARTED') {
    const updated = await db.onboardingCase.update({
      where: { id: onboardingCase.id },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    });
    await recordActivity(db, {
      actor,
      entityType: 'onboarding',
      entityId: updated.id,
      expertId,
      action: 'onboarding.started',
      summary: `Onboarding checklist opened for ${expert.fullName}`,
      metadata: { itemCount: ONBOARDING_CHECKLIST.length },
    });
    return updated;
  }

  if (onboardingCase.status === 'REJECTED') {
    const reopened = await db.onboardingCase.update({
      where: { id: onboardingCase.id },
      data: { status: 'IN_PROGRESS', submittedAt: null },
    });
    await recordActivity(db, {
      actor,
      entityType: 'onboarding',
      entityId: reopened.id,
      expertId,
      action: 'onboarding.reopened',
      summary: `Onboarding reopened for ${expert.fullName}`,
    });
    return reopened;
  }

  return onboardingCase;
}

export async function getOnboardingCase(db: Db, expertId: string) {
  const onboardingCase = await db.onboardingCase.findUnique({
    where: { expertId },
    include: {
      items: { orderBy: { position: 'asc' } },
      expert: true,
      verifiedBy: { select: { id: true, name: true, email: true } },
    },
  });
  if (!onboardingCase) throw notFound('This expert has no onboarding case yet.');
  return onboardingCase;
}

export interface ChecklistAnswer {
  key: string;
  /** ATTESTATION items expect "true"/"false"; TEXT and REFERENCE expect a string. */
  value: string;
}

function validateAnswer(template: ChecklistItemTemplate, value: string): string {
  const trimmed = value.trim();
  if (template.kind === 'ATTESTATION') {
    if (trimmed !== 'true' && trimmed !== 'false') {
      throw badRequest(`"${template.label}" must be answered true or false.`);
    }
    return trimmed;
  }
  if (template.required && trimmed.length === 0) {
    throw badRequest(`"${template.label}" is required.`);
  }
  if (trimmed.length > 2000) {
    throw badRequest(`"${template.label}" is too long (2000 character limit).`);
  }
  return trimmed;
}

/** Saving answers is a partial update: an expert may fill the form over several visits. */
export async function saveChecklistAnswers(
  db: Db,
  actor: Actor,
  expertId: string,
  answers: ChecklistAnswer[],
) {
  const onboardingCase = await db.onboardingCase.findUnique({
    where: { expertId },
    include: { items: true, expert: true },
  });
  if (!onboardingCase) throw notFound('This expert has no onboarding case yet.');
  if (onboardingCase.status === 'SUBMITTED') {
    throw invalidState('Your checklist is already submitted and is waiting on operator review.');
  }
  if (onboardingCase.status === 'VERIFIED') {
    throw invalidState('Your onboarding is already verified and cannot be edited.');
  }
  // Editing a not-yet-started or returned case reopens it. Without this a
  // returned expert could save answers but never resubmit them.
  if (onboardingCase.status === 'NOT_STARTED' || onboardingCase.status === 'REJECTED') {
    await db.onboardingCase.update({
      where: { id: onboardingCase.id },
      data: {
        status: 'IN_PROGRESS',
        startedAt: onboardingCase.startedAt ?? new Date(),
        submittedAt: null,
      },
    });
    if (onboardingCase.expert.status === 'REJECTED') {
      await setExpertStatus(db, actor, expertId, 'ONBOARDING', {
        reason: 'expert reopened a returned onboarding submission',
      });
    }
  }

  const itemsByKey = new Map(onboardingCase.items.map((item) => [item.key, item]));
  const now = new Date();

  for (const answer of answers) {
    const item = itemsByKey.get(answer.key);
    const template = CHECKLIST_BY_KEY.get(answer.key);
    if (!item || !template) throw badRequest(`Unknown checklist item "${answer.key}".`);

    const value = validateAnswer(template, answer.value);
    const complete = template.kind === 'ATTESTATION' ? value === 'true' : value.length > 0;

    await db.onboardingItem.update({
      where: { id: item.id },
      data: { value, completedAt: complete ? (item.completedAt ?? now) : null },
    });
  }

  await recordActivity(db, {
    actor,
    entityType: 'onboarding',
    entityId: onboardingCase.id,
    expertId,
    action: 'onboarding.progress_saved',
    summary: `${onboardingCase.expert.fullName} saved ${answers.length} checklist answer(s)`,
    metadata: { keys: answers.map((a) => a.key) },
  });

  return getOnboardingCase(db, expertId);
}

export function outstandingRequiredItems(
  items: Array<{ key: string; label: string; required: boolean; completedAt: Date | null }>,
) {
  return items.filter((item) => item.required && !item.completedAt);
}

/**
 * Expert submits the checklist for human review.
 *
 * This moves the expert to PENDING_VERIFICATION. It does NOT verify them: that
 * is an explicit operator confirmation, handled by `decideVerification`.
 */
export async function submitOnboarding(db: Db, actor: Actor, expertId: string) {
  const onboardingCase = await db.onboardingCase.findUnique({
    where: { expertId },
    include: { items: { orderBy: { position: 'asc' } }, expert: true },
  });
  if (!onboardingCase) throw notFound('This expert has no onboarding case yet.');

  assertTransition('Onboarding case', ONBOARDING_TRANSITIONS, onboardingCase.status, 'SUBMITTED');

  const outstanding = outstandingRequiredItems(onboardingCase.items);
  if (outstanding.length > 0) {
    throw invalidState(`Cannot submit: ${outstanding.length} required item(s) still outstanding.`, {
      outstanding: outstanding.map((item) => ({ key: item.key, label: item.label })),
    });
  }

  const updated = await db.onboardingCase.update({
    where: { id: onboardingCase.id },
    data: { status: 'SUBMITTED', submittedAt: new Date(), nudgedAt: null },
  });

  if (onboardingCase.expert.status === 'ONBOARDING') {
    await setExpertStatus(db, actor, expertId, 'PENDING_VERIFICATION', {
      reason: 'onboarding checklist submitted',
    });
  }

  await recordActivity(db, {
    actor,
    entityType: 'onboarding',
    entityId: updated.id,
    expertId,
    action: 'onboarding.submitted',
    summary: `${onboardingCase.expert.fullName} submitted the onboarding checklist for review`,
  });

  return updated;
}

export interface VerificationDecisionInput {
  expertId: string;
  approve: boolean;
  note?: string;
}

/**
 * HUMAN OPERATOR CONFIRMATION.
 *
 * Nothing in the system verifies an expert automatically. An operator with the
 * `onboarding:verify` capability must make this call explicitly, and the
 * decision (with the operator's identity) is written to the activity history.
 */
export async function decideVerification(db: Db, actor: Actor, input: VerificationDecisionInput) {
  const onboardingCase = await db.onboardingCase.findUnique({
    where: { expertId: input.expertId },
    include: { expert: true, items: true },
  });
  if (!onboardingCase) throw notFound('This expert has no onboarding case yet.');

  const target = input.approve ? 'VERIFIED' : 'REJECTED';
  assertTransition('Onboarding case', ONBOARDING_TRANSITIONS, onboardingCase.status, target);

  if (!input.approve && !input.note?.trim()) {
    throw badRequest('A reason is required when returning an onboarding submission.');
  }

  const now = new Date();

  // Guard against two operators deciding the same case at once: the update only
  // applies while the case is still SUBMITTED.
  const claimed = await db.onboardingCase.updateMany({
    where: { id: onboardingCase.id, status: 'SUBMITTED' },
    data: {
      status: target,
      verifiedAt: now,
      verifiedById: actor.userId ?? null,
      decisionNote: input.note?.trim() ?? null,
    },
  });
  if (claimed.count === 0) {
    throw invalidState('This onboarding case was already decided by another operator.');
  }

  await setExpertStatus(db, actor, input.expertId, input.approve ? 'VERIFIED' : 'REJECTED', {
    reason: input.approve ? 'operator verified onboarding' : 'operator returned onboarding',
  });

  await recordActivity(db, {
    actor,
    entityType: 'onboarding',
    entityId: onboardingCase.id,
    expertId: input.expertId,
    action: input.approve ? 'onboarding.verified' : 'onboarding.rejected',
    summary: input.approve
      ? `${actor.label} verified ${onboardingCase.expert.fullName}`
      : `${actor.label} returned ${onboardingCase.expert.fullName}'s submission for changes`,
    metadata: { note: input.note?.trim() ?? null, decidedBy: actor.label },
  });

  return db.onboardingCase.findUniqueOrThrow({
    where: { id: onboardingCase.id },
    include: { expert: true, items: { orderBy: { position: 'asc' } } },
  });
}

export async function listVerificationQueue(db: Db, limit = 50) {
  return db.onboardingCase.findMany({
    where: { status: 'SUBMITTED' },
    orderBy: { submittedAt: 'asc' },
    take: limit,
    include: {
      expert: { include: { skills: { include: { skill: true } } } },
      items: { orderBy: { position: 'asc' } },
    },
  });
}

export async function onboardingCounts(db: Db) {
  const grouped = await db.onboardingCase.groupBy({ by: ['status'], _count: { _all: true } });
  const counts = { NOT_STARTED: 0, IN_PROGRESS: 0, SUBMITTED: 0, VERIFIED: 0, REJECTED: 0 };
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
}

/** Cases stalled long enough to warrant a nudge from the worker. */
export async function findStalledOnboarding(
  db: Db,
  options: { nudgeAfterHours: number; now?: Date; limit?: number },
) {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.nudgeAfterHours * 3_600_000);
  const where: Prisma.OnboardingCaseWhereInput = {
    status: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
    createdAt: { lte: cutoff },
    OR: [{ nudgedAt: null }, { nudgedAt: { lte: cutoff } }],
    expert: { status: { notIn: ['ARCHIVED'] } },
  };
  return db.onboardingCase.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: options.limit ?? 25,
    include: { expert: true, items: { orderBy: { position: 'asc' } } },
  });
}
