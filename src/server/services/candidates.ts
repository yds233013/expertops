import {
  type Application,
  type Candidate,
  type CandidateStage,
  type DuplicateFlag,
  type Prisma,
} from '@prisma/client';
import { type Db, isPrismaErrorCode, PG_UNIQUE_VIOLATION } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, invalidState, notFound } from '@/lib/errors';
import { formatReference, parseReferenceSequence } from '@/lib/ids';
import { type Actor, recordActivity } from './activity';
import { enqueueJob } from './jobs';

/**
 * Candidates: people in the intake pipeline.
 *
 * A candidate is not an expert. Conversion is an explicit step that happens
 * only after a human qualification decision, so nobody joins the network by
 * side effect of filling in a form.
 */
export const CANDIDATE_REFERENCE_PREFIX = 'CAN';
export const APPLICATION_REFERENCE_PREFIX = 'APP';

export async function nextCandidateReference(db: Db): Promise<string> {
  // Only well-formed references count towards the sequence; see
  // nextExpertReference for why lexical MAX is unsafe here.
  const rows = await db.candidate.findMany({
    where: { reference: { startsWith: `${CANDIDATE_REFERENCE_PREFIX}-` } },
    select: { reference: true },
  });

  let highest = 0;
  for (const row of rows) {
    const sequence = parseReferenceSequence(CANDIDATE_REFERENCE_PREFIX, row.reference);
    if (sequence > highest) highest = sequence;
  }
  return formatReference(CANDIDATE_REFERENCE_PREFIX, highest + 1);
}

async function nextApplicationReference(db: Db): Promise<string> {
  // Only well-formed references count towards the sequence; see
  // nextExpertReference for why lexical MAX is unsafe here.
  const rows = await db.application.findMany({
    where: { reference: { startsWith: `${APPLICATION_REFERENCE_PREFIX}-` } },
    select: { reference: true },
  });

  let highest = 0;
  for (const row of rows) {
    const sequence = parseReferenceSequence(APPLICATION_REFERENCE_PREFIX, row.reference);
    if (sequence > highest) highest = sequence;
  }
  return formatReference(APPLICATION_REFERENCE_PREFIX, highest + 1);
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Normalise a name for comparison only.
 *
 * Used exclusively to spot possible duplicates for a human to look at. It never
 * feeds a scoring decision and never merges anything on its own.
 */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface CreateCandidateInput {
  fullName: string;
  email: string;
  headline?: string;
  timezone?: string;
  yearsExperience?: number;
  sourceChannelId?: string | null;
  referredByExpertId?: string | null;
  campaignId?: string | null;
  relationshipOwnerId?: string | null;
  notes?: string;
  nextActionAt?: Date | null;
  nextActionNote?: string;
}

export async function createCandidate(
  db: Db,
  actor: Actor,
  input: CreateCandidateInput,
): Promise<{ candidate: Candidate; duplicateFlags: DuplicateFlag[] }> {
  const email = normaliseEmail(input.email);
  if (!email.includes('@')) throw badRequest('A valid email address is required.');
  if (!input.fullName.trim()) throw badRequest('Full name is required.');

  const candidate = await db.candidate.create({
    data: {
      reference: await nextCandidateReference(db),
      fullName: input.fullName.trim(),
      email,
      headline: input.headline?.trim() ?? '',
      timezone: input.timezone?.trim() || 'UTC',
      yearsExperience: input.yearsExperience ?? 0,
      sourceChannelId: input.sourceChannelId ?? null,
      referredByExpertId: input.referredByExpertId ?? null,
      campaignId: input.campaignId ?? null,
      relationshipOwnerId: input.relationshipOwnerId ?? actor.userId ?? null,
      notes: input.notes?.trim() ?? '',
      nextActionAt: input.nextActionAt ?? null,
      nextActionNote: input.nextActionNote?.trim() ?? '',
      createdById: actor.userId ?? null,
    },
  });

  const duplicateFlags = await detectDuplicates(db, candidate.id);

  await recordActivity(db, {
    actor,
    entityType: 'candidate',
    entityId: candidate.id,
    action: 'candidate.created',
    summary: `Candidate ${candidate.reference} (${candidate.fullName}) entered the pipeline`,
    metadata: {
      sourceChannelId: input.sourceChannelId ?? null,
      campaignId: input.campaignId ?? null,
      duplicateFlags: duplicateFlags.length,
    },
  });

  // A suspected duplicate parks the person until a human decides. Nothing is
  // merged, and no outreach happens while the question is open.
  if (duplicateFlags.length === 0) {
    return { candidate, duplicateFlags };
  }

  // Re-read so callers see the hold rather than the pre-update row.
  const held = await db.candidate.update({
    where: { id: candidate.id },
    data: { stage: 'DUPLICATE_HOLD' },
  });
  return { candidate: held, duplicateFlags };
}

/**
 * Look for people who may already exist.
 *
 * Deliberately conservative and advisory: an exact email match is near-certain,
 * a name match is a prompt to look. Neither ever merges records, and a flag
 * blocks progression until an operator resolves it.
 */
export async function detectDuplicates(db: Db, candidateId: string): Promise<DuplicateFlag[]> {
  const candidate = await db.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate) throw notFound('Candidate not found.');

  const normalisedName = normaliseName(candidate.fullName);
  const flags: DuplicateFlag[] = [];

  const addFlag = async (data: {
    matchedCandidateId?: string;
    matchedExpertId?: string;
    reason: string;
    score: number;
  }) => {
    try {
      flags.push(
        await db.duplicateFlag.create({
          data: {
            candidateId,
            matchedCandidateId: data.matchedCandidateId ?? null,
            matchedExpertId: data.matchedExpertId ?? null,
            reason: data.reason,
            score: data.score,
            status: 'OPEN',
          },
        }),
      );
    } catch (error) {
      // The pair was already flagged; nothing further to record.
      if (!isPrismaErrorCode(error, PG_UNIQUE_VIOLATION)) throw error;
    }
  };

  const expertByEmail = await db.expert.findUnique({ where: { email: candidate.email } });
  if (expertByEmail) {
    await addFlag({
      matchedExpertId: expertByEmail.id,
      reason: `Exact email match with existing expert ${expertByEmail.reference}`,
      score: 95,
    });
  }

  const candidatesByEmail = await db.candidate.findMany({
    where: { email: candidate.email, id: { not: candidateId } },
  });
  for (const other of candidatesByEmail) {
    await addFlag({
      matchedCandidateId: other.id,
      reason: `Exact email match with candidate ${other.reference}`,
      score: 95,
    });
  }

  if (normalisedName.length >= 5) {
    const sameNameExperts = await db.expert.findMany({
      where: { fullName: { equals: candidate.fullName, mode: 'insensitive' } },
      take: 5,
    });
    for (const expert of sameNameExperts) {
      if (expert.email === candidate.email) continue; // already flagged above
      await addFlag({
        matchedExpertId: expert.id,
        reason: `Same name as existing expert ${expert.reference} (different email)`,
        score: 55,
      });
    }

    const sameNameCandidates = await db.candidate.findMany({
      where: {
        id: { not: candidateId },
        fullName: { equals: candidate.fullName, mode: 'insensitive' },
      },
      take: 5,
    });
    for (const other of sameNameCandidates) {
      if (other.email === candidate.email) continue;
      await addFlag({
        matchedCandidateId: other.id,
        reason: `Same name as candidate ${other.reference} (different email)`,
        score: 50,
      });
    }
  }

  return flags;
}

export interface ResolveDuplicateInput {
  flagId: string;
  samePerson: boolean;
  note: string;
}

/**
 * HUMAN DECISION. Resolve a suspected duplicate.
 *
 * Confirming two records are the same person withdraws the newer candidate and
 * points at the original. It does not delete anything or move data between
 * records: an operator can see both sides afterwards.
 */
export async function resolveDuplicate(
  db: Db,
  actor: Actor,
  input: ResolveDuplicateInput,
): Promise<DuplicateFlag> {
  if (!input.note.trim()) throw badRequest('A note explaining the decision is required.');

  const flag = await db.duplicateFlag.findUnique({
    where: { id: input.flagId },
    include: { candidate: true, matchedCandidate: true, matchedExpert: true },
  });
  if (!flag) throw notFound('Duplicate flag not found.');
  if (flag.status !== 'OPEN') {
    throw invalidState('This duplicate flag was already resolved.');
  }

  const at = clockNow();
  const claimed = await db.duplicateFlag.updateMany({
    where: { id: input.flagId, status: 'OPEN' },
    data: {
      status: input.samePerson ? 'CONFIRMED_SAME' : 'CONFIRMED_DIFFERENT',
      resolvedById: actor.userId ?? null,
      resolvedAt: at,
      resolutionNote: input.note.trim(),
    },
  });
  if (claimed.count === 0) {
    throw invalidState('This duplicate flag was resolved by someone else.');
  }

  if (input.samePerson) {
    await db.candidate.update({
      where: { id: flag.candidateId },
      data: {
        stage: 'WITHDRAWN',
        notes: `${flag.candidate.notes}\n[duplicate] ${input.note.trim()}`.trim(),
      },
    });
  } else {
    // Release the hold only when no other flag is still open for this person.
    const stillOpen = await db.duplicateFlag.count({
      where: { candidateId: flag.candidateId, status: 'OPEN' },
    });
    if (stillOpen === 0 && flag.candidate.stage === 'DUPLICATE_HOLD') {
      await db.candidate.update({ where: { id: flag.candidateId }, data: { stage: 'NEW' } });
    }
  }

  await recordActivity(db, {
    actor,
    entityType: 'candidate',
    entityId: flag.candidateId,
    expertId: flag.matchedExpertId,
    action: input.samePerson ? 'duplicate.confirmed_same' : 'duplicate.confirmed_different',
    summary: input.samePerson
      ? `${actor.label} confirmed ${flag.candidate.reference} is the same person as an existing record`
      : `${actor.label} confirmed ${flag.candidate.reference} is a different person`,
    metadata: { flagId: flag.id, note: input.note.trim(), reason: flag.reason },
  });

  return db.duplicateFlag.findUniqueOrThrow({ where: { id: input.flagId } });
}

export async function listOpenDuplicates(db: Db, limit = 50) {
  return db.duplicateFlag.findMany({
    where: { status: 'OPEN' },
    orderBy: [{ score: 'desc' }, { createdAt: 'asc' }],
    take: limit,
    include: {
      candidate: true,
      matchedCandidate: { select: { id: true, reference: true, fullName: true, email: true } },
      matchedExpert: { select: { id: true, reference: true, fullName: true, email: true } },
    },
  });
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export interface SubmitApplicationInput {
  candidateId: string;
  domainId: string;
  campaignId?: string | null;
  answers?: Record<string, unknown>;
  /** Synthetic links. Stored as text; the application never fetches them. */
  workSampleLinks?: string[];
}

export const MAX_WORK_SAMPLE_LINKS = 10;

/**
 * Validate a supplied work-sample link.
 *
 * The link is recorded as evidence for a human to look at. It is never fetched
 * by the server, so this only guards against storing something that would be
 * dangerous to render, not against a malicious destination.
 */
export function validateWorkSampleLink(raw: string): string {
  const value = raw.trim();
  if (!value) throw badRequest('A work sample link cannot be blank.');
  if (value.length > 500) throw badRequest('Work sample links are limited to 500 characters.');

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest(`"${value}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw badRequest('Work sample links must be http or https.');
  }
  return value;
}

export async function submitApplication(
  db: Db,
  actor: Actor,
  input: SubmitApplicationInput,
): Promise<Application> {
  const candidate = await db.candidate.findUnique({ where: { id: input.candidateId } });
  if (!candidate) throw notFound('Candidate not found.');
  if (candidate.contactOptOutAt) {
    throw invalidState('This person has opted out of contact and cannot be progressed.');
  }

  const domain = await db.domain.findUnique({ where: { id: input.domainId } });
  if (!domain) throw notFound('Domain not found.');

  const links = (input.workSampleLinks ?? [])
    .slice(0, MAX_WORK_SAMPLE_LINKS)
    .map(validateWorkSampleLink);

  const application = await db.application.create({
    data: {
      reference: await nextApplicationReference(db),
      candidateId: input.candidateId,
      domainId: input.domainId,
      campaignId: input.campaignId ?? candidate.campaignId ?? null,
      answers: (input.answers ?? {}) as Prisma.InputJsonValue,
      workSampleLinks: links as Prisma.InputJsonValue,
      status: 'SUBMITTED',
    },
  });

  await recordActivity(db, {
    actor,
    entityType: 'application',
    entityId: application.id,
    candidateId: candidate.id,
    action: 'application.submitted',
    summary: `${candidate.fullName} applied for ${domain.name} work (${application.reference})`,
    metadata: { candidateId: candidate.id, domainId: domain.id, linkCount: links.length },
  });

  // Scheduled inside the caller's transaction: the application and its
  // follow-up either both land or neither does.
  await enqueueJob(db, {
    type: 'application.acknowledge',
    payload: { applicationId: application.id },
    priority: 30,
    dedupeKey: `application.acknowledge:${application.id}`,
  });

  return application;
}

export async function acknowledgeApplication(
  db: Db,
  applicationId: string,
  options: { now?: Date } = {},
): Promise<boolean> {
  const at = options.now ?? clockNow();
  const claimed = await db.application.updateMany({
    where: { id: applicationId, status: 'SUBMITTED', acknowledgedAt: null },
    data: { status: 'ACKNOWLEDGED', acknowledgedAt: at },
  });
  return claimed.count > 0;
}

// ---------------------------------------------------------------------------
// Pipeline management
// ---------------------------------------------------------------------------

export const CANDIDATE_STAGE_TRANSITIONS: Record<CandidateStage, CandidateStage[]> = {
  NEW: ['DUPLICATE_HOLD', 'SCREENING_INVITED', 'REJECTED', 'WITHDRAWN'],
  DUPLICATE_HOLD: ['NEW', 'WITHDRAWN', 'REJECTED'],
  SCREENING_INVITED: ['SCREENING_SUBMITTED', 'REJECTED', 'WITHDRAWN'],
  // QUALIFIED is reachable directly because grantQualification accepts a
  // screening in SUBMITTED as well as IN_REVIEW. The screening status is the
  // authority; this table must not contradict it.
  SCREENING_SUBMITTED: ['IN_REVIEW', 'REVISION_REQUESTED', 'QUALIFIED', 'REJECTED', 'WITHDRAWN'],
  IN_REVIEW: ['QUALIFIED', 'REJECTED', 'REVISION_REQUESTED', 'WITHDRAWN'],
  REVISION_REQUESTED: ['SCREENING_SUBMITTED', 'REJECTED', 'WITHDRAWN'],
  QUALIFIED: ['WITHDRAWN'],
  REJECTED: ['NEW'],
  WITHDRAWN: ['NEW'],
};

export async function setCandidateStage(
  db: Db,
  actor: Actor,
  candidateId: string,
  to: CandidateStage,
  options: { reason?: string; silent?: boolean } = {},
): Promise<Candidate> {
  const candidate = await db.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate) throw notFound('Candidate not found.');
  if (candidate.stage === to) return candidate;

  const allowed = CANDIDATE_STAGE_TRANSITIONS[candidate.stage];
  if (!allowed.includes(to)) {
    throw invalidState(
      `Candidate cannot move from ${candidate.stage} to ${to}. Allowed: ${allowed.join(', ') || 'none'}.`,
      { from: candidate.stage, to, allowed },
    );
  }

  const updated = await db.candidate.update({ where: { id: candidateId }, data: { stage: to } });

  if (!options.silent) {
    await recordActivity(db, {
      actor,
      entityType: 'candidate',
      entityId: candidateId,
      action: 'candidate.stage_changed',
      summary: `Candidate ${candidate.reference} moved from ${candidate.stage} to ${to}`,
      metadata: { from: candidate.stage, to, reason: options.reason ?? null },
    });
  }
  return updated;
}

export interface UpdateRelationshipInput {
  relationshipOwnerId?: string | null;
  notes?: string;
  nextActionAt?: Date | null;
  nextActionNote?: string;
}

export async function updateRelationship(
  db: Db,
  actor: Actor,
  candidateId: string,
  input: UpdateRelationshipInput,
): Promise<Candidate> {
  const candidate = await db.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate) throw notFound('Candidate not found.');

  const data: Prisma.CandidateUpdateInput = {};
  if (input.relationshipOwnerId !== undefined) {
    data.relationshipOwner = input.relationshipOwnerId
      ? { connect: { id: input.relationshipOwnerId } }
      : { disconnect: true };
  }
  if (input.notes !== undefined) data.notes = input.notes.trim();
  if (input.nextActionAt !== undefined) data.nextActionAt = input.nextActionAt;
  if (input.nextActionNote !== undefined) data.nextActionNote = input.nextActionNote.trim();

  const updated = await db.candidate.update({ where: { id: candidateId }, data });
  await recordActivity(db, {
    actor,
    entityType: 'candidate',
    entityId: candidateId,
    action: 'candidate.relationship_updated',
    summary: `${actor.label} updated relationship details for ${candidate.reference}`,
    metadata: { fields: Object.keys(data) },
  });
  return updated;
}

/**
 * Opt a person out of contact.
 *
 * Honoured by the outbox, by outreach batches, and by screening reminders. An
 * opt-out is never reversed automatically.
 */
export async function optOutCandidate(
  db: Db,
  actor: Actor,
  candidateId: string,
  reason: string,
): Promise<Candidate> {
  const candidate = await db.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate) throw notFound('Candidate not found.');
  if (candidate.contactOptOutAt) return candidate;

  const updated = await db.candidate.update({
    where: { id: candidateId },
    data: { contactOptOutAt: clockNow(), contactOptOutReason: reason.trim() || 'No reason given' },
  });

  await recordActivity(db, {
    actor,
    entityType: 'candidate',
    entityId: candidateId,
    action: 'candidate.opted_out',
    summary: `${candidate.fullName} opted out of further contact`,
    metadata: { reason: reason.trim() || null },
  });
  return updated;
}

export interface CandidateQuery {
  stage?: CandidateStage;
  search?: string;
  campaignId?: string;
  relationshipOwnerId?: string;
  dueOnly?: boolean;
  limit?: number;
}

export async function listCandidates(db: Db, query: CandidateQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const where: Prisma.CandidateWhereInput = {};
  if (query.stage) where.stage = query.stage;
  if (query.campaignId) where.campaignId = query.campaignId;
  if (query.relationshipOwnerId) where.relationshipOwnerId = query.relationshipOwnerId;
  if (query.dueOnly) where.nextActionAt = { lte: clockNow() };
  if (query.search) {
    where.OR = [
      { fullName: { contains: query.search, mode: 'insensitive' } },
      { email: { contains: query.search, mode: 'insensitive' } },
      { reference: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  return db.candidate.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }],
    take: limit,
    include: {
      sourceChannel: true,
      campaign: { select: { id: true, code: true, name: true } },
      relationshipOwner: { select: { id: true, name: true } },
      applications: { include: { domain: true }, orderBy: { submittedAt: 'desc' } },
      screenings: { orderBy: { createdAt: 'desc' }, take: 1 },
      duplicateFlags: { where: { status: 'OPEN' } },
    },
  });
}

export async function getCandidate(db: Db, candidateId: string) {
  const candidate = await db.candidate.findUnique({
    where: { id: candidateId },
    include: {
      sourceChannel: true,
      campaign: true,
      relationshipOwner: { select: { id: true, name: true, email: true } },
      referredByExpert: { select: { id: true, reference: true, fullName: true } },
      expert: { select: { id: true, reference: true, fullName: true, status: true } },
      applications: { include: { domain: true }, orderBy: { submittedAt: 'desc' } },
      screenings: {
        orderBy: { createdAt: 'desc' },
        include: {
          rubricVersion: { include: { template: { include: { domain: true } } } },
          submissions: { orderBy: { revision: 'desc' } },
          reviews: { include: { reviewer: { select: { id: true, name: true } } } },
          conflict: true,
        },
      },
      duplicateFlags: {
        include: {
          matchedCandidate: { select: { id: true, reference: true, fullName: true, email: true } },
          matchedExpert: { select: { id: true, reference: true, fullName: true, email: true } },
        },
      },
    },
  });
  if (!candidate) throw notFound('Candidate not found.');
  return candidate;
}

export async function candidateCountsByStage(db: Db) {
  const grouped = await db.candidate.groupBy({ by: ['stage'], _count: { _all: true } });
  const counts: Record<CandidateStage, number> = {
    NEW: 0,
    DUPLICATE_HOLD: 0,
    SCREENING_INVITED: 0,
    SCREENING_SUBMITTED: 0,
    IN_REVIEW: 0,
    REVISION_REQUESTED: 0,
    QUALIFIED: 0,
    REJECTED: 0,
    WITHDRAWN: 0,
  };
  for (const row of grouped) counts[row.stage] = row._count._all;
  return counts;
}
