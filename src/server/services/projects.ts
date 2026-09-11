import { type Prisma, type Project, type ProjectStatus } from '@prisma/client';
import { type Db, isPrismaErrorCode, PG_UNIQUE_VIOLATION } from '@/lib/db';
import { badRequest, conflict, invalidState, notFound } from '@/lib/errors';
import { formatReference, parseReferenceSequence, PROJECT_REFERENCE_PREFIX } from '@/lib/ids';
import { assertTransition, PROJECT_TRANSITIONS } from '@/server/domain/state-machines';
import { type Actor, recordActivity, SYSTEM_ACTOR } from './activity';
import { enqueueJob } from './jobs';
import { upsertSkillByName } from './experts';

export interface RequirementInput {
  skillName: string;
  required?: boolean;
  minProficiency?: number;
  weight?: number;
}

export interface CreateProjectInput {
  title: string;
  clientName: string;
  description?: string;
  seatsRequested?: number;
  minYearsExperience?: number;
  maxHourlyRateCents?: number | null;
  preferredTimezone?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  requirements?: RequirementInput[];
}

function validateRequirement(requirement: RequirementInput) {
  const skillName = requirement.skillName.trim();
  if (!skillName) throw badRequest('Requirement skill name cannot be blank.');
  const minProficiency = requirement.minProficiency ?? 1;
  if (!Number.isInteger(minProficiency) || minProficiency < 1 || minProficiency > 5) {
    throw badRequest(`Minimum proficiency for "${skillName}" must be between 1 and 5.`);
  }
  const weight = requirement.weight ?? 1;
  if (!Number.isInteger(weight) || weight < 1 || weight > 5) {
    throw badRequest(`Weight for "${skillName}" must be between 1 and 5.`);
  }
  return { skillName, required: requirement.required ?? false, minProficiency, weight };
}

export async function nextProjectCode(db: Db): Promise<string> {
  const latest = await db.project.findFirst({ orderBy: { code: 'desc' }, select: { code: true } });
  return formatReference(
    PROJECT_REFERENCE_PREFIX,
    parseReferenceSequence(PROJECT_REFERENCE_PREFIX, latest?.code) + 1,
  );
}

export async function createProject(
  db: Db,
  actor: Actor & { userId?: string | null },
  input: CreateProjectInput,
): Promise<Project> {
  if (!actor.userId) throw badRequest('Projects must be created by a signed-in operator.');
  if (!input.title.trim()) throw badRequest('Project title is required.');
  if (!input.clientName.trim()) throw badRequest('Client name is required.');

  const seats = input.seatsRequested ?? 1;
  if (!Number.isInteger(seats) || seats < 1 || seats > 50) {
    throw badRequest('Seats requested must be an integer between 1 and 50.');
  }
  if (input.startDate && input.endDate && input.endDate < input.startDate) {
    throw badRequest('Project end date cannot be before the start date.');
  }
  if (input.maxHourlyRateCents != null && input.maxHourlyRateCents < 0) {
    throw badRequest('Rate ceiling cannot be negative.');
  }

  const requirements = (input.requirements ?? []).map(validateRequirement);
  const seen = new Set<string>();
  for (const requirement of requirements) {
    const key = requirement.skillName.toLowerCase();
    if (seen.has(key)) throw badRequest(`Requirement "${requirement.skillName}" is listed twice.`);
    seen.add(key);
  }
  const skills = await Promise.all(requirements.map((r) => upsertSkillByName(db, r.skillName)));

  try {
    const project = await db.project.create({
      data: {
        code: await nextProjectCode(db),
        title: input.title.trim(),
        clientName: input.clientName.trim(),
        description: input.description?.trim() ?? '',
        seatsRequested: seats,
        minYearsExperience: input.minYearsExperience ?? 0,
        maxHourlyRateCents: input.maxHourlyRateCents ?? null,
        preferredTimezone: input.preferredTimezone?.trim() || 'UTC',
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        createdById: actor.userId,
        requirements: {
          create: requirements.map((requirement, index) => ({
            skillId: skills[index]!.id,
            required: requirement.required,
            minProficiency: requirement.minProficiency,
            weight: requirement.weight,
          })),
        },
      },
    });

    await recordActivity(db, {
      actor,
      entityType: 'project',
      entityId: project.id,
      projectId: project.id,
      action: 'project.created',
      summary: `Project ${project.code} "${project.title}" created for ${project.clientName}`,
      metadata: { seatsRequested: seats, requirements: requirements.map((r) => r.skillName) },
    });

    return project;
  } catch (error) {
    if (isPrismaErrorCode(error, PG_UNIQUE_VIOLATION)) {
      throw conflict('A project with that code already exists. Retry the request.');
    }
    throw error;
  }
}

export interface UpdateProjectInput {
  title?: string;
  clientName?: string;
  description?: string;
  seatsRequested?: number;
  minYearsExperience?: number;
  maxHourlyRateCents?: number | null;
  preferredTimezone?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  requirements?: RequirementInput[];
}

export async function updateProject(
  db: Db,
  actor: Actor,
  projectId: string,
  input: UpdateProjectInput,
): Promise<Project> {
  const existing = await db.project.findUnique({ where: { id: projectId } });
  if (!existing) throw notFound('Project not found.');
  if (existing.status === 'CLOSED' || existing.status === 'CANCELLED') {
    throw invalidState(
      `Project ${existing.code} is ${existing.status} and can no longer be edited.`,
    );
  }

  if (input.seatsRequested !== undefined) {
    if (!Number.isInteger(input.seatsRequested) || input.seatsRequested < 1) {
      throw badRequest('Seats requested must be a positive integer.');
    }
    if (input.seatsRequested < existing.seatsFilled) {
      throw invalidState(
        `Cannot reduce seats to ${input.seatsRequested}: ${existing.seatsFilled} seat(s) are already filled. Release an assignment first.`,
      );
    }
  }

  if (input.requirements) {
    const requirements = input.requirements.map(validateRequirement);
    const skills = await Promise.all(requirements.map((r) => upsertSkillByName(db, r.skillName)));
    await db.projectSkillRequirement.deleteMany({ where: { projectId } });
    if (requirements.length > 0) {
      await db.projectSkillRequirement.createMany({
        data: requirements.map((requirement, index) => ({
          projectId,
          skillId: skills[index]!.id,
          required: requirement.required,
          minProficiency: requirement.minProficiency,
          weight: requirement.weight,
        })),
      });
    }
  }

  const data: Prisma.ProjectUpdateInput = {};
  if (input.title !== undefined) data.title = input.title.trim();
  if (input.clientName !== undefined) data.clientName = input.clientName.trim();
  if (input.description !== undefined) data.description = input.description.trim();
  if (input.seatsRequested !== undefined) data.seatsRequested = input.seatsRequested;
  if (input.minYearsExperience !== undefined) data.minYearsExperience = input.minYearsExperience;
  if (input.maxHourlyRateCents !== undefined) data.maxHourlyRateCents = input.maxHourlyRateCents;
  if (input.preferredTimezone !== undefined) {
    data.preferredTimezone = input.preferredTimezone.trim() || 'UTC';
  }
  if (input.startDate !== undefined) data.startDate = input.startDate;
  if (input.endDate !== undefined) data.endDate = input.endDate;

  const project = await db.project.update({ where: { id: projectId }, data });

  await recordActivity(db, {
    actor,
    entityType: 'project',
    entityId: project.id,
    projectId: project.id,
    action: 'project.updated',
    summary: `Project ${project.code} updated`,
    metadata: { fields: Object.keys(data), requirementsReplaced: Boolean(input.requirements) },
  });

  return project;
}

export async function setProjectStatus(
  db: Db,
  actor: Actor,
  projectId: string,
  to: ProjectStatus,
  options: { reason?: string; silent?: boolean } = {},
): Promise<Project> {
  const existing = await db.project.findUnique({
    where: { id: projectId },
    include: { requirements: true },
  });
  if (!existing) throw notFound('Project not found.');
  if (existing.status === to) return existing;

  assertTransition('Project', PROJECT_TRANSITIONS, existing.status, to);

  // A project cannot open for matching without at least one requirement,
  // otherwise every expert in the network scores identically.
  if (to === 'MATCHING' && existing.requirements.length === 0) {
    throw invalidState(
      `Project ${existing.code} has no skill requirements. Add at least one before opening it for matching.`,
    );
  }
  if (to === 'ACTIVE' && existing.seatsFilled < existing.seatsRequested) {
    throw invalidState(
      `Project ${existing.code} has ${existing.seatsFilled}/${existing.seatsRequested} seats filled and cannot be marked ACTIVE yet.`,
    );
  }

  const project = await db.project.update({ where: { id: projectId }, data: { status: to } });

  if (to === 'CLOSED' || to === 'CANCELLED') {
    await enqueueJob(db, {
      type: 'project.offboarding_tasks',
      payload: { projectId },
      priority: 50,
      dedupeKey: `project.offboarding_tasks:${projectId}`,
    });
  }

  if (!options.silent) {
    await recordActivity(db, {
      actor,
      entityType: 'project',
      entityId: project.id,
      projectId: project.id,
      action: 'project.status_changed',
      summary: `Project ${project.code} moved from ${existing.status} to ${to}`,
      metadata: { from: existing.status, to, reason: options.reason ?? null },
    });
  }

  return project;
}

/**
 * Advance a project's status as a side effect of another workflow step.
 *
 * Used by invitation/staffing services so the board reflects reality without an
 * operator having to click through statuses manually. Illegal transitions are
 * skipped silently here: the caller's action is the point, not the status nudge.
 *
 * The history entry is attributed to SYSTEM rather than to whoever triggered
 * the surrounding action: nobody chose to move the project, the workflow did.
 * `triggeredBy` records who was acting at the time.
 */
export async function advanceProjectStatus(
  db: Db,
  triggeredBy: Actor,
  projectId: string,
  to: ProjectStatus,
): Promise<void> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.status === to) return;
  if (!PROJECT_TRANSITIONS[project.status].includes(to)) return;

  const updated = await db.project.update({ where: { id: projectId }, data: { status: to } });
  await recordActivity(db, {
    actor: SYSTEM_ACTOR,
    entityType: 'project',
    entityId: projectId,
    projectId,
    action: 'project.status_advanced',
    summary: `Project ${updated.code} advanced automatically from ${project.status} to ${to}`,
    metadata: {
      from: project.status,
      to,
      automated: true,
      triggeredBy: triggeredBy.label,
      triggeredByType: triggeredBy.type,
    },
  });
}

export interface ProjectQuery {
  status?: ProjectStatus | ProjectStatus[];
  search?: string;
  limit?: number;
  cursor?: string;
}

export async function listProjects(db: Db, query: ProjectQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const where: Prisma.ProjectWhereInput = {};
  if (query.status)
    where.status = Array.isArray(query.status) ? { in: query.status } : query.status;
  if (query.search) {
    where.OR = [
      { title: { contains: query.search, mode: 'insensitive' } },
      { clientName: { contains: query.search, mode: 'insensitive' } },
      { code: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const rows = await db.project.findMany({
    where,
    include: {
      requirements: { include: { skill: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      _count: { select: { invitations: true, assignments: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  return {
    projects: hasMore ? rows.slice(0, limit) : rows,
    nextCursor: hasMore ? (rows[limit - 1]?.id ?? null) : null,
  };
}

export async function getProject(db: Db, projectId: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: {
      requirements: { include: { skill: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      invitations: {
        include: { expert: true },
        orderBy: [{ createdAt: 'desc' }],
      },
      assignments: { include: { expert: true }, orderBy: [{ createdAt: 'desc' }] },
      availability: { include: { expert: true }, orderBy: { startAt: 'asc' } },
      matchRuns: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: {
          createdBy: { select: { id: true, name: true } },
          candidates: {
            orderBy: { rank: 'asc' },
            include: { expert: { include: { skills: { include: { skill: true } } } } },
          },
        },
      },
    },
  });
  if (!project) throw notFound('Project not found.');
  return project;
}

export async function getProjectByCode(db: Db, code: string) {
  const project = await db.project.findUnique({ where: { code } });
  if (!project) throw notFound(`Project ${code} not found.`);
  return project;
}

export async function projectCountsByStatus(db: Db): Promise<Record<ProjectStatus, number>> {
  const grouped = await db.project.groupBy({ by: ['status'], _count: { _all: true } });
  const counts: Record<ProjectStatus, number> = {
    DRAFT: 0,
    MATCHING: 0,
    INVITING: 0,
    STAFFING: 0,
    ACTIVE: 0,
    CLOSED: 0,
    CANCELLED: 0,
  };
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
}
