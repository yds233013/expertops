import { type Prisma } from '@prisma/client';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { invalidState, notFound } from '@/lib/errors';
import {
  ALGORITHM_VERSION,
  type CandidateInput,
  DEFAULT_WEIGHTS,
  type MatchWeights,
  type ProjectCriteria,
  rankCandidates,
} from '@/server/domain/matching-engine';
import { PROJECT_STATUSES_OPEN_FOR_MATCHING } from '@/server/domain/state-machines';
import { type Actor, recordActivity } from './activity';

/**
 * Match runs.
 *
 * This service loads the candidate pool, hands it to the pure scoring engine,
 * and persists the ranking as an immutable MatchRun. It is called identically
 * from the operator UI (`POST /api/projects/:id/match`) and from the worker's
 * `matching.run` job.
 */
export interface RunMatchingOptions {
  weights?: Partial<MatchWeights>;
  /** Maximum number of non-excluded candidates to persist. */
  limit?: number;
  /** Persist excluded experts too, so the operator can see who was skipped. */
  includeExcluded?: boolean;
  hoursPerWeekNeeded?: number;
  now?: Date;
}

export async function runMatching(
  db: Db,
  actor: Actor,
  projectId: string,
  options: RunMatchingOptions = {},
) {
  const now = options.now ?? clockNow();
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const weights: MatchWeights = { ...DEFAULT_WEIGHTS, ...options.weights };

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { requirements: { include: { skill: true } } },
  });
  if (!project) throw notFound('Project not found.');

  if (!PROJECT_STATUSES_OPEN_FOR_MATCHING.includes(project.status)) {
    throw invalidState(
      `Project ${project.code} is ${project.status}. Matching runs only for: ${PROJECT_STATUSES_OPEN_FOR_MATCHING.join(', ')}.`,
    );
  }
  if (project.requirements.length === 0) {
    throw invalidState(`Project ${project.code} has no skill requirements to match against.`);
  }

  const criteria: ProjectCriteria = {
    minYearsExperience: project.minYearsExperience,
    maxHourlyRateCents: project.maxHourlyRateCents,
    preferredTimezone: project.preferredTimezone,
    hoursPerWeekNeeded: options.hoursPerWeekNeeded ?? 20,
    requirements: project.requirements.map((requirement) => ({
      slug: requirement.skill.slug,
      required: requirement.required,
      minProficiency: requirement.minProficiency,
      weight: requirement.weight,
    })),
  };

  const pool = await loadCandidatePool(db, projectId);
  const ranked = rankCandidates(pool, criteria, weights, now);

  const eligible = ranked.filter((candidate) => !candidate.excluded).slice(0, limit);
  const excluded = options.includeExcluded !== false ? ranked.filter((c) => c.excluded) : [];

  const params = {
    weights: { ...weights },
    limit,
    criteria: {
      minYearsExperience: criteria.minYearsExperience,
      maxHourlyRateCents: criteria.maxHourlyRateCents,
      preferredTimezone: criteria.preferredTimezone,
      hoursPerWeekNeeded: criteria.hoursPerWeekNeeded,
      requirements: criteria.requirements,
    },
  } satisfies Record<string, unknown>;

  const matchRun = await db.matchRun.create({
    data: {
      projectId,
      createdById: actor.userId ?? null,
      algorithmVersion: ALGORITHM_VERSION,
      params: params as unknown as Prisma.InputJsonValue,
      consideredCount: pool.length,
      candidateCount: eligible.length,
      excludedCount: ranked.length - ranked.filter((c) => !c.excluded).length,
      candidates: {
        create: [
          ...eligible.map((candidate, index) => ({
            expertId: candidate.expertId,
            score: candidate.score,
            rank: index + 1,
            breakdown: candidate.breakdown as unknown as Prisma.InputJsonValue,
            excluded: false,
            exclusionReason: null,
          })),
          ...excluded.map((candidate, index) => ({
            expertId: candidate.expertId,
            score: candidate.score,
            rank: eligible.length + index + 1,
            breakdown: candidate.breakdown as unknown as Prisma.InputJsonValue,
            excluded: true,
            exclusionReason: candidate.exclusionReason,
          })),
        ],
      },
    },
    include: {
      candidates: {
        orderBy: { rank: 'asc' },
        include: { expert: { include: { skills: { include: { skill: true } } } } },
      },
    },
  });

  await recordActivity(db, {
    actor,
    entityType: 'project',
    entityId: projectId,
    projectId,
    action: 'matching.run',
    summary: `Match run scored ${pool.length} expert(s), producing ${eligible.length} candidate(s)`,
    metadata: {
      matchRunId: matchRun.id,
      algorithmVersion: ALGORITHM_VERSION,
      consideredCount: pool.length,
      candidateCount: eligible.length,
      excludedCount: matchRun.excludedCount,
    },
  });

  return matchRun;
}

/**
 * Assemble the scoring inputs for every expert who could plausibly be matched.
 *
 * Archived experts are filtered in SQL; every other exclusion is decided by the
 * pure engine so the reason is recorded rather than silently dropped.
 */
export async function loadCandidatePool(db: Db, projectId: string): Promise<CandidateInput[]> {
  const experts = await db.expert.findMany({
    where: { status: { notIn: ['ARCHIVED'] } },
    include: {
      skills: { include: { skill: true } },
      invitations: {
        where: { status: { in: ['DRAFT', 'SENT', 'ACCEPTED'] } },
        select: { projectId: true },
      },
      assignments: {
        where: { status: { in: ['PROPOSED', 'CONFIRMED'] } },
        select: { projectId: true, status: true },
      },
    },
  });

  // Most recent decline per expert, used for the cool-off rule.
  const declines = await db.invitation.groupBy({
    by: ['expertId'],
    where: { status: 'DECLINED', respondedAt: { not: null } },
    _max: { respondedAt: true },
  });
  const lastDeclineByExpert = new Map(
    declines.map((row) => [row.expertId, row._max.respondedAt ?? null]),
  );

  return experts.map((expert) => ({
    expertId: expert.id,
    status: expert.status,
    yearsExperience: expert.yearsExperience,
    hourlyRateCents: expert.hourlyRateCents,
    timezone: expert.timezone,
    weeklyCapacityHours: expert.weeklyCapacityHours,
    skills: expert.skills.map((link) => ({
      slug: link.skill.slug,
      proficiency: link.proficiency,
      yearsUsed: link.yearsUsed,
    })),
    hasOpenInvitationForProject: expert.invitations.some((i) => i.projectId === projectId),
    isAssignedToProject: expert.assignments.some((a) => a.projectId === projectId),
    lastDeclinedAt: lastDeclineByExpert.get(expert.id) ?? null,
    activeAssignmentCount: expert.assignments.filter((a) => a.status === 'CONFIRMED').length,
  }));
}

export async function getLatestMatchRun(db: Db, projectId: string) {
  return db.matchRun.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    include: {
      createdBy: { select: { id: true, name: true } },
      candidates: {
        orderBy: { rank: 'asc' },
        include: { expert: { include: { skills: { include: { skill: true } } } } },
      },
    },
  });
}

export async function getMatchRun(db: Db, matchRunId: string) {
  const run = await db.matchRun.findUnique({
    where: { id: matchRunId },
    include: {
      project: true,
      candidates: {
        orderBy: { rank: 'asc' },
        include: { expert: { include: { skills: { include: { skill: true } } } } },
      },
    },
  });
  if (!run) throw notFound('Match run not found.');
  return run;
}

export async function listMatchRuns(db: Db, projectId: string, limit = 10) {
  return db.matchRun.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { createdBy: { select: { id: true, name: true } } },
  });
}
