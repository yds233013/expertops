import {
  type Opportunity,
  type OpportunityKind,
  type OpportunityStatus,
  type Prisma,
} from '@prisma/client';
import { type Db, type MaybeTransactor, withTransaction } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, conflict, invalidState, notFound } from '@/lib/errors';
import { slugify } from '@/lib/ids';
import { type Actor, recordActivity } from './activity';

/**
 * Opportunities: the things a person can apply to.
 *
 * Two rules are enforced here rather than by hiding a link, because a link is
 * not a permission. A draft is invisible to applicants, and a closed or expired
 * opportunity refuses applications. Both are checked in the service, so they
 * hold for anything that can reach it.
 *
 * The candidate-facing projection is a separate function from the operator one
 * on purpose. Internal notes and the client's identity live on the same row as
 * the public description, and the safest way to keep them apart is to have one
 * function that cannot return them.
 */
const REFERENCE_PREFIX = 'OPP';
const MAX_QUESTIONS = 10;
const MAX_SKILLS = 20;

export interface OpportunityQuestion {
  key: string;
  label: string;
  helpText?: string;
  required: boolean;
}

async function nextReference(db: Db): Promise<string> {
  const rows = await db.opportunity.findMany({
    where: { reference: { startsWith: `${REFERENCE_PREFIX}-` } },
    select: { reference: true },
  });
  let highest = 0;
  for (const row of rows) {
    const match = /^OPP-(\d+)$/.exec(row.reference);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${REFERENCE_PREFIX}-${String(highest + 1).padStart(4, '0')}`;
}

async function uniqueSlug(db: Db, title: string, ignoreId?: string): Promise<string> {
  const base = slugify(title) || 'opportunity';
  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    const existing = await db.opportunity.findUnique({ where: { slug: candidate } });
    if (!existing || existing.id === ignoreId) return candidate;
  }
  throw conflict('Could not derive a unique address for this title. Try a different one.');
}

function normaliseQuestions(input: OpportunityQuestion[] | undefined): OpportunityQuestion[] {
  const questions = (input ?? []).slice(0, MAX_QUESTIONS);
  const seen = new Set<string>();
  return questions.map((question, index) => {
    const key = slugify(question.key || question.label) || `question-${index + 1}`;
    if (seen.has(key)) throw badRequest(`Question "${key}" is listed twice.`);
    seen.add(key);
    const label = question.label.trim();
    if (!label) throw badRequest('Every question needs a label.');
    return {
      key,
      label: label.slice(0, 300),
      helpText: question.helpText?.trim().slice(0, 500) || undefined,
      required: Boolean(question.required),
    };
  });
}

function normaliseSkills(input: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input ?? []) {
    const name = raw.trim().slice(0, 80);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_SKILLS) break;
  }
  return out;
}

export interface OpportunityInput {
  title: string;
  kind?: OpportunityKind;
  domainId: string;
  projectId?: string | null;
  campaignId?: string | null;
  summary?: string;
  description?: string;
  responsibilities?: string;
  requiredSkills?: string[];
  questions?: OpportunityQuestion[];
  weeklyHoursMin?: number | null;
  weeklyHoursMax?: number | null;
  startDate?: Date | null;
  endDate?: Date | null;
  applicationDeadline?: Date | null;
  compensationNote?: string;
  internalNotes?: string;
}

function validateHours(min?: number | null, max?: number | null) {
  if (min != null && (min < 1 || min > 80)) {
    throw badRequest('Expected weekly hours must be between 1 and 80.');
  }
  if (max != null && (max < 1 || max > 80)) {
    throw badRequest('Expected weekly hours must be between 1 and 80.');
  }
  if (min != null && max != null && min > max) {
    throw badRequest('The lower weekly-hours figure cannot exceed the upper one.');
  }
}

export async function createOpportunity(
  db: MaybeTransactor,
  actor: Actor,
  input: OpportunityInput,
): Promise<Opportunity> {
  const title = input.title.trim();
  if (!title) throw badRequest('An opportunity needs a title.');
  validateHours(input.weeklyHoursMin, input.weeklyHoursMax);

  return withTransaction(db, async (tx) => {
    const domain = await tx.domain.findUnique({ where: { id: input.domainId } });
    if (!domain) throw notFound('Domain not found.');
    if (input.projectId) {
      const project = await tx.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw notFound('Project not found.');
    }
    if (input.campaignId) {
      const campaign = await tx.sourcingCampaign.findUnique({ where: { id: input.campaignId } });
      if (!campaign) throw notFound('Campaign not found.');
    }

    const opportunity = await tx.opportunity.create({
      data: {
        reference: await nextReference(tx),
        slug: await uniqueSlug(tx, title),
        title,
        kind: input.kind ?? 'PROJECT_ENGAGEMENT',
        domainId: input.domainId,
        projectId: input.projectId ?? null,
        campaignId: input.campaignId ?? null,
        summary: (input.summary ?? '').trim().slice(0, 500),
        description: (input.description ?? '').trim(),
        responsibilities: (input.responsibilities ?? '').trim(),
        requiredSkills: normaliseSkills(input.requiredSkills) as Prisma.InputJsonValue,
        questions: normaliseQuestions(input.questions) as unknown as Prisma.InputJsonValue,
        weeklyHoursMin: input.weeklyHoursMin ?? null,
        weeklyHoursMax: input.weeklyHoursMax ?? null,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        applicationDeadline: input.applicationDeadline ?? null,
        compensationNote: (input.compensationNote ?? '').trim().slice(0, 500),
        internalNotes: (input.internalNotes ?? '').trim(),
        createdById: actor.userId ?? null,
      },
    });

    await recordActivity(tx, {
      actor,
      entityType: 'opportunity',
      entityId: opportunity.id,
      action: 'opportunity.created',
      summary: `${actor.label} drafted opportunity ${opportunity.reference} "${opportunity.title}"`,
      projectId: opportunity.projectId,
    });
    return opportunity;
  });
}

export async function updateOpportunity(
  db: MaybeTransactor,
  actor: Actor,
  opportunityId: string,
  input: Partial<OpportunityInput>,
): Promise<Opportunity> {
  validateHours(input.weeklyHoursMin, input.weeklyHoursMax);

  return withTransaction(db, async (tx) => {
    const existing = await tx.opportunity.findUnique({ where: { id: opportunityId } });
    if (!existing) throw notFound('Opportunity not found.');
    if (existing.status === 'CLOSED') {
      throw invalidState('This opportunity is closed. Reopen it before editing.');
    }

    const title = input.title?.trim();
    if (title !== undefined && !title) throw badRequest('An opportunity needs a title.');

    const data: Prisma.OpportunityUpdateInput = {};
    if (title) {
      data.title = title;
      if (title !== existing.title) data.slug = await uniqueSlug(tx, title, existing.id);
    }
    if (input.kind) data.kind = input.kind;
    if (input.summary !== undefined) data.summary = input.summary.trim().slice(0, 500);
    if (input.description !== undefined) data.description = input.description.trim();
    if (input.responsibilities !== undefined) {
      data.responsibilities = input.responsibilities.trim();
    }
    if (input.requiredSkills !== undefined) {
      data.requiredSkills = normaliseSkills(input.requiredSkills) as Prisma.InputJsonValue;
    }
    if (input.questions !== undefined) {
      data.questions = normaliseQuestions(input.questions) as unknown as Prisma.InputJsonValue;
    }
    if (input.weeklyHoursMin !== undefined) data.weeklyHoursMin = input.weeklyHoursMin;
    if (input.weeklyHoursMax !== undefined) data.weeklyHoursMax = input.weeklyHoursMax;
    if (input.startDate !== undefined) data.startDate = input.startDate;
    if (input.endDate !== undefined) data.endDate = input.endDate;
    if (input.applicationDeadline !== undefined) {
      data.applicationDeadline = input.applicationDeadline;
    }
    if (input.compensationNote !== undefined) {
      data.compensationNote = input.compensationNote.trim().slice(0, 500);
    }
    if (input.internalNotes !== undefined) data.internalNotes = input.internalNotes.trim();
    if (input.projectId !== undefined) {
      if (input.projectId) {
        const project = await tx.project.findUnique({ where: { id: input.projectId } });
        if (!project) throw notFound('Project not found.');
      }
      data.project = input.projectId ? { connect: { id: input.projectId } } : { disconnect: true };
    }

    const updated = await tx.opportunity.update({ where: { id: opportunityId }, data });
    await recordActivity(tx, {
      actor,
      entityType: 'opportunity',
      entityId: updated.id,
      action: 'opportunity.updated',
      summary: `${actor.label} edited opportunity ${updated.reference}`,
      projectId: updated.projectId,
    });
    return updated;
  });
}

/**
 * Publishing is the moment an opportunity becomes reachable by an applicant, so
 * it checks that there is enough on the page to be worth reading.
 */
export async function publishOpportunity(
  db: MaybeTransactor,
  actor: Actor,
  opportunityId: string,
): Promise<Opportunity> {
  return withTransaction(db, async (tx) => {
    const existing = await tx.opportunity.findUnique({ where: { id: opportunityId } });
    if (!existing) throw notFound('Opportunity not found.');
    if (existing.status === 'PUBLISHED') return existing;
    if (existing.status === 'CLOSED') {
      throw invalidState('This opportunity is closed. A closed listing is not republished.');
    }
    if (!existing.summary.trim() && !existing.description.trim()) {
      throw invalidState('Add a summary or a description before publishing.');
    }
    if (existing.applicationDeadline && existing.applicationDeadline <= clockNow()) {
      throw invalidState('The application deadline is in the past.');
    }

    const published = await tx.opportunity.update({
      where: { id: opportunityId },
      data: { status: 'PUBLISHED', publishedAt: clockNow(), closedAt: null },
    });
    await recordActivity(tx, {
      actor,
      entityType: 'opportunity',
      entityId: published.id,
      action: 'opportunity.published',
      summary: `${actor.label} published opportunity ${published.reference} "${published.title}"`,
      projectId: published.projectId,
    });
    return published;
  });
}

export async function closeOpportunity(
  db: MaybeTransactor,
  actor: Actor,
  opportunityId: string,
  reason: string,
): Promise<Opportunity> {
  const trimmed = reason.trim();
  if (!trimmed) throw badRequest('A reason is required to close an opportunity.');

  return withTransaction(db, async (tx) => {
    const existing = await tx.opportunity.findUnique({ where: { id: opportunityId } });
    if (!existing) throw notFound('Opportunity not found.');
    if (existing.status === 'CLOSED') return existing;

    const closed = await tx.opportunity.update({
      where: { id: opportunityId },
      data: { status: 'CLOSED', closedAt: clockNow() },
    });
    await recordActivity(tx, {
      actor,
      entityType: 'opportunity',
      entityId: closed.id,
      action: 'opportunity.closed',
      summary: `${actor.label} closed opportunity ${closed.reference}: ${trimmed}`,
      projectId: closed.projectId,
      metadata: { reason: trimmed },
    });
    return closed;
  });
}

/** Whether this opportunity is accepting applications, and if not, why not. */
export function acceptanceState(
  opportunity: Pick<Opportunity, 'status' | 'applicationDeadline'>,
  now: Date = clockNow(),
): { open: boolean; reason?: string } {
  if (opportunity.status === 'DRAFT') {
    return { open: false, reason: 'This opportunity is not open for applications.' };
  }
  if (opportunity.status === 'CLOSED') {
    return {
      open: false,
      reason: 'This opportunity has closed and is no longer accepting applications.',
    };
  }
  if (opportunity.applicationDeadline && opportunity.applicationDeadline <= now) {
    return { open: false, reason: 'The deadline for this opportunity has passed.' };
  }
  return { open: true };
}

/**
 * What an applicant is allowed to see.
 *
 * Deliberately a whitelist. `internalNotes` and the campaign are not on it, and
 * adding a field to the model does not add it to this.
 */
export interface PublicOpportunity {
  reference: string;
  slug: string;
  title: string;
  kind: OpportunityKind;
  domainName: string;
  summary: string;
  description: string;
  responsibilities: string;
  requiredSkills: string[];
  questions: OpportunityQuestion[];
  weeklyHoursMin: number | null;
  weeklyHoursMax: number | null;
  startDate: Date | null;
  endDate: Date | null;
  applicationDeadline: Date | null;
  compensationNote: string;
  open: boolean;
  closedReason?: string;
}

type OpportunityWithDomain = Opportunity & { domain: { name: string } };

export function toPublicOpportunity(
  opportunity: OpportunityWithDomain,
  now: Date = clockNow(),
): PublicOpportunity {
  const acceptance = acceptanceState(opportunity, now);
  return {
    reference: opportunity.reference,
    slug: opportunity.slug,
    title: opportunity.title,
    kind: opportunity.kind,
    domainName: opportunity.domain.name,
    summary: opportunity.summary,
    description: opportunity.description,
    responsibilities: opportunity.responsibilities,
    requiredSkills: (opportunity.requiredSkills as string[]) ?? [],
    questions: (opportunity.questions as unknown as OpportunityQuestion[]) ?? [],
    weeklyHoursMin: opportunity.weeklyHoursMin,
    weeklyHoursMax: opportunity.weeklyHoursMax,
    startDate: opportunity.startDate,
    endDate: opportunity.endDate,
    applicationDeadline: opportunity.applicationDeadline,
    compensationNote: opportunity.compensationNote,
    open: acceptance.open,
    closedReason: acceptance.reason,
  };
}

/**
 * The listing an applicant sees.
 *
 * Only published rows, and the query says so rather than the caller filtering
 * afterwards — a draft must never be one forgotten `.filter()` away from being
 * public.
 */
export async function listPublishedOpportunities(
  db: Db,
  now: Date = clockNow(),
): Promise<PublicOpportunity[]> {
  const rows = await db.opportunity.findMany({
    where: { status: 'PUBLISHED' },
    include: { domain: { select: { name: true } } },
    orderBy: [{ publishedAt: 'desc' }],
    take: 100,
  });
  return rows.map((row) => toPublicOpportunity(row, now));
}

export async function findPublishedBySlug(
  db: Db,
  slug: string,
  now: Date = clockNow(),
): Promise<PublicOpportunity | null> {
  const row = await db.opportunity.findFirst({
    where: { slug, status: { in: ['PUBLISHED', 'CLOSED'] } },
    include: { domain: { select: { name: true } } },
  });
  // A closed opportunity still renders, so a bookmarked link explains itself
  // rather than 404ing. A draft does not exist as far as an applicant is
  // concerned.
  return row ? toPublicOpportunity(row, now) : null;
}

/** The operator view: everything, including what applicants never see. */
export async function listOpportunities(db: Db, status?: OpportunityStatus) {
  return db.opportunity.findMany({
    where: status ? { status } : undefined,
    include: {
      domain: { select: { name: true } },
      project: { select: { id: true, code: true, title: true } },
      campaign: { select: { id: true, name: true } },
      _count: { select: { applications: true } },
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 200,
  });
}

export async function getOpportunity(db: Db, opportunityId: string) {
  const opportunity = await db.opportunity.findUnique({
    where: { id: opportunityId },
    include: {
      domain: { select: { id: true, name: true } },
      project: { select: { id: true, code: true, title: true } },
      campaign: { select: { id: true, name: true } },
      createdBy: { select: { name: true } },
    },
  });
  if (!opportunity) throw notFound('Opportunity not found.');
  return opportunity;
}

export async function opportunityCounts(db: Db) {
  const rows = await db.opportunity.groupBy({ by: ['status'], _count: { _all: true } });
  const counts: Record<OpportunityStatus, number> = { DRAFT: 0, PUBLISHED: 0, CLOSED: 0 };
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}
