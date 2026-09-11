import { type Expert, type ExpertStatus, type Prisma } from '@prisma/client';
import { type Db, isPrismaErrorCode, PG_UNIQUE_VIOLATION, uniqueViolationTarget } from '@/lib/db';
import { badRequest, conflict, notFound } from '@/lib/errors';
import {
  EXPERT_REFERENCE_PREFIX,
  formatReference,
  parseReferenceSequence,
  slugify,
} from '@/lib/ids';
import { assertTransition, EXPERT_TRANSITIONS } from '@/server/domain/state-machines';
import { type Actor, recordActivity } from './activity';

export interface SkillInput {
  /** Skill name; matched case-insensitively, created if it does not exist. */
  name: string;
  proficiency?: number;
  yearsUsed?: number;
}

export interface CreateExpertInput {
  fullName: string;
  email: string;
  headline: string;
  bio?: string;
  yearsExperience?: number;
  timezone?: string;
  hourlyRateCents?: number;
  currency?: string;
  weeklyCapacityHours?: number;
  notes?: string;
  skills?: SkillInput[];
}

function normaliseSkillInput(skill: SkillInput) {
  const name = skill.name.trim();
  if (!name) throw badRequest('Skill name cannot be blank.');
  const proficiency = skill.proficiency ?? 3;
  if (!Number.isInteger(proficiency) || proficiency < 1 || proficiency > 5) {
    throw badRequest(`Proficiency for "${name}" must be an integer between 1 and 5.`);
  }
  const yearsUsed = skill.yearsUsed ?? 0;
  if (!Number.isInteger(yearsUsed) || yearsUsed < 0 || yearsUsed > 60) {
    throw badRequest(`Years used for "${name}" must be between 0 and 60.`);
  }
  return { name, slug: slugify(name), proficiency, yearsUsed };
}

export async function upsertSkillByName(db: Db, name: string) {
  const slug = slugify(name);
  if (!slug) throw badRequest('Skill name cannot be blank.');
  return db.skill.upsert({
    where: { slug },
    update: {},
    create: { slug, name: name.trim() },
  });
}

/**
 * Allocate the next EXP-nnnn reference.
 *
 * Only references that actually match the EXP-<digits> shape are considered.
 * Sorting the whole column lexically is not safe: a record created by a test
 * factory or an import with a different shape can sort highest and silently
 * reset the counter to 1, which then collides on the next insert.
 */
export async function nextExpertReference(db: Db): Promise<string> {
  const rows = await db.expert.findMany({
    where: { reference: { startsWith: `${EXPERT_REFERENCE_PREFIX}-` } },
    select: { reference: true },
  });

  let highest = 0;
  for (const row of rows) {
    const sequence = parseReferenceSequence(EXPERT_REFERENCE_PREFIX, row.reference);
    if (sequence > highest) highest = sequence;
  }
  return formatReference(EXPERT_REFERENCE_PREFIX, highest + 1);
}

export async function createExpert(
  db: Db,
  actor: Actor,
  input: CreateExpertInput,
): Promise<Expert> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) throw badRequest('A valid email address is required.');
  if (!input.fullName.trim()) throw badRequest('Full name is required.');
  if ((input.hourlyRateCents ?? 0) < 0) throw badRequest('Hourly rate cannot be negative.');
  if ((input.yearsExperience ?? 0) < 0) throw badRequest('Years of experience cannot be negative.');

  const skills = (input.skills ?? []).map(normaliseSkillInput);
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.slug)) throw badRequest(`Skill "${skill.name}" is listed twice.`);
    seen.add(skill.slug);
  }

  const skillRecords = await Promise.all(skills.map((s) => upsertSkillByName(db, s.name)));

  try {
    const expert = await db.expert.create({
      data: {
        reference: await nextExpertReference(db),
        fullName: input.fullName.trim(),
        email,
        headline: input.headline.trim(),
        bio: input.bio?.trim() ?? '',
        yearsExperience: input.yearsExperience ?? 0,
        timezone: input.timezone?.trim() || 'UTC',
        hourlyRateCents: input.hourlyRateCents ?? 0,
        currency: input.currency ?? 'USD',
        weeklyCapacityHours: input.weeklyCapacityHours ?? 0,
        notes: input.notes?.trim() ?? '',
        skills: {
          create: skills.map((skill, index) => ({
            skillId: skillRecords[index]!.id,
            proficiency: skill.proficiency,
            yearsUsed: skill.yearsUsed,
          })),
        },
      },
    });

    await recordActivity(db, {
      actor,
      entityType: 'expert',
      entityId: expert.id,
      expertId: expert.id,
      action: 'expert.created',
      summary: `Expert ${expert.reference} (${expert.fullName}) added to the network`,
      metadata: { skills: skills.map((s) => s.name) },
    });

    return expert;
  } catch (error) {
    if (isPrismaErrorCode(error, PG_UNIQUE_VIOLATION)) {
      const target = uniqueViolationTarget(error);
      if (target.includes('reference')) {
        // Two inserts raced for the same reference. Retrying is correct.
        throw conflict('A reference collision occurred while creating this expert. Retry.', {
          target,
        });
      }
      throw conflict(`An expert with email ${email} already exists.`, { target });
    }
    throw error;
  }
}

export interface UpdateExpertInput {
  fullName?: string;
  headline?: string;
  bio?: string;
  yearsExperience?: number;
  timezone?: string;
  hourlyRateCents?: number;
  currency?: string;
  weeklyCapacityHours?: number;
  notes?: string;
  skills?: SkillInput[];
}

export async function updateExpert(
  db: Db,
  actor: Actor,
  expertId: string,
  input: UpdateExpertInput,
): Promise<Expert> {
  const existing = await db.expert.findUnique({ where: { id: expertId } });
  if (!existing) throw notFound('Expert not found.');

  if (input.skills) {
    const skills = input.skills.map(normaliseSkillInput);
    const records = await Promise.all(skills.map((s) => upsertSkillByName(db, s.name)));
    await db.expertSkill.deleteMany({ where: { expertId } });
    if (skills.length > 0) {
      await db.expertSkill.createMany({
        data: skills.map((skill, index) => ({
          expertId,
          skillId: records[index]!.id,
          proficiency: skill.proficiency,
          yearsUsed: skill.yearsUsed,
        })),
      });
    }
  }

  const data: Prisma.ExpertUpdateInput = {};
  if (input.fullName !== undefined) data.fullName = input.fullName.trim();
  if (input.headline !== undefined) data.headline = input.headline.trim();
  if (input.bio !== undefined) data.bio = input.bio.trim();
  if (input.yearsExperience !== undefined) data.yearsExperience = input.yearsExperience;
  if (input.timezone !== undefined) data.timezone = input.timezone.trim() || 'UTC';
  if (input.hourlyRateCents !== undefined) data.hourlyRateCents = input.hourlyRateCents;
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.weeklyCapacityHours !== undefined) data.weeklyCapacityHours = input.weeklyCapacityHours;
  if (input.notes !== undefined) data.notes = input.notes.trim();

  const expert = await db.expert.update({ where: { id: expertId }, data });

  await recordActivity(db, {
    actor,
    entityType: 'expert',
    entityId: expert.id,
    expertId: expert.id,
    action: 'expert.updated',
    summary: `Expert ${expert.reference} profile updated`,
    metadata: { fields: Object.keys(data), skillsReplaced: Boolean(input.skills) },
  });

  return expert;
}

/**
 * Change expert lifecycle status.
 *
 * The transition table is the only authority; callers never special-case a
 * status themselves.
 */
export async function setExpertStatus(
  db: Db,
  actor: Actor,
  expertId: string,
  to: ExpertStatus,
  options: { reason?: string; silent?: boolean } = {},
): Promise<Expert> {
  const existing = await db.expert.findUnique({ where: { id: expertId } });
  if (!existing) throw notFound('Expert not found.');
  if (existing.status === to) return existing;

  assertTransition('Expert', EXPERT_TRANSITIONS, existing.status, to);

  const expert = await db.expert.update({ where: { id: expertId }, data: { status: to } });

  if (!options.silent) {
    await recordActivity(db, {
      actor,
      entityType: 'expert',
      entityId: expert.id,
      expertId: expert.id,
      action: 'expert.status_changed',
      summary: `Expert ${expert.reference} moved from ${existing.status} to ${to}`,
      metadata: { from: existing.status, to, reason: options.reason ?? null },
    });
  }

  return expert;
}

export interface ExpertQuery {
  status?: ExpertStatus | ExpertStatus[];
  search?: string;
  skillSlugs?: string[];
  maxHourlyRateCents?: number;
  minYearsExperience?: number;
  limit?: number;
  cursor?: string;
}

export function buildExpertWhere(query: ExpertQuery): Prisma.ExpertWhereInput {
  const where: Prisma.ExpertWhereInput = {};
  if (query.status) {
    where.status = Array.isArray(query.status) ? { in: query.status } : query.status;
  }
  if (query.search) {
    where.OR = [
      { fullName: { contains: query.search, mode: 'insensitive' } },
      { email: { contains: query.search, mode: 'insensitive' } },
      { headline: { contains: query.search, mode: 'insensitive' } },
      { reference: { contains: query.search, mode: 'insensitive' } },
    ];
  }
  if (query.skillSlugs?.length) {
    where.AND = query.skillSlugs.map((slug) => ({ skills: { some: { skill: { slug } } } }));
  }
  if (typeof query.maxHourlyRateCents === 'number') {
    where.hourlyRateCents = { lte: query.maxHourlyRateCents };
  }
  if (typeof query.minYearsExperience === 'number') {
    where.yearsExperience = { gte: query.minYearsExperience };
  }
  return where;
}

export async function listExperts(db: Db, query: ExpertQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const where = buildExpertWhere(query);
  const rows = await db.expert.findMany({
    where,
    include: { skills: { include: { skill: true } }, onboardingCase: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  return {
    experts: hasMore ? rows.slice(0, limit) : rows,
    nextCursor: hasMore ? (rows[limit - 1]?.id ?? null) : null,
  };
}

export async function getExpert(db: Db, expertId: string) {
  const expert = await db.expert.findUnique({
    where: { id: expertId },
    include: {
      skills: { include: { skill: true }, orderBy: { proficiency: 'desc' } },
      onboardingCase: { include: { items: { orderBy: { position: 'asc' } }, verifiedBy: true } },
      availability: { orderBy: { startAt: 'asc' }, include: { project: true } },
      invitations: { include: { project: true }, orderBy: { createdAt: 'desc' } },
      assignments: { include: { project: true }, orderBy: { createdAt: 'desc' } },
    },
  });
  if (!expert) throw notFound('Expert not found.');
  return expert;
}

export async function expertCountsByStatus(db: Db): Promise<Record<ExpertStatus, number>> {
  const grouped = await db.expert.groupBy({ by: ['status'], _count: { _all: true } });
  const counts: Record<ExpertStatus, number> = {
    PROSPECT: 0,
    ONBOARDING: 0,
    PENDING_VERIFICATION: 0,
    VERIFIED: 0,
    REJECTED: 0,
    ARCHIVED: 0,
  };
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
}

export async function listSkills(db: Db) {
  return db.skill.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { experts: true } } },
  });
}
