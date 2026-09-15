import { type Db } from '@/lib/db';

/**
 * The read-only demo projection.
 *
 * Everything an anonymous visitor can see is assembled here, and nowhere else.
 * That is the whole design: one file to audit, rather than a role whose reach
 * has to be re-checked every time a page is added.
 *
 * The existing VIEWER role was considered and rejected. It carries
 * `outbox:read`, which is single-use magic links; `activity:read`, which names
 * operators; `payment:read` and `candidate:read`, which are money and people.
 * A role that broad cannot be handed to a stranger, and narrowing it would
 * still leave the operator pages rendering whatever they like.
 *
 * Two rules hold everything below:
 *
 *  * **Whitelisted records.** Only rows whose name carries one of the synthetic
 *    prefixes are readable. A record belonging to a real person cannot appear
 *    here even by accident, because it will not match.
 *  * **Whitelisted fields.** Every query names the columns it wants. There is no
 *    `include`, no spread of a model, and no path by which a column added later
 *    becomes visible without somebody editing this file.
 *
 * Deliberately absent, and not reachable from here at all: candidates,
 * applications, screenings, the outbox, activity, payments, operators, sessions
 * and tokens.
 */

/** Records the demo may describe. Anything else is invisible to it. */
const SYNTHETIC_PREFIXES = ['PRACTICE ', 'NET ', 'SYNTHETIC '] as const;

function syntheticNameFilter(field: 'title' | 'fullName' | 'name') {
  return { OR: SYNTHETIC_PREFIXES.map((prefix) => ({ [field]: { startsWith: prefix } })) };
}

export interface DemoNetwork {
  expertsByStatus: { status: string; count: number }[];
  totalExperts: number;
}

export interface DemoProject {
  code: string;
  title: string;
  status: string;
  seatsFilled: number;
  seatsRequested: number;
  requirements: string[];
  maxHourlyRateCents: number | null;
}

export interface DemoRanking {
  projectCode: string;
  projectTitle: string;
  algorithmVersion: string;
  consideredCount: number;
  rankedCount: number;
  excludedCount: number;
  /** Pseudonymous on purpose: a reference and a score, never an address. */
  top: { reference: string; rank: number; score: number }[];
  exclusions: { reason: string; count: number }[];
}

export interface DemoOverview {
  network: DemoNetwork;
  projects: DemoProject[];
  ranking: DemoRanking | null;
  openOpportunities: number;
  jobsSucceeded: number;
  jobsFailed: number;
}

/**
 * Aggregate shape of the network. Counts only — no person appears here.
 */
async function demoNetwork(db: Db): Promise<DemoNetwork> {
  const rows = await db.expert.groupBy({
    by: ['status'],
    where: syntheticNameFilter('fullName'),
    _count: true,
  });
  return {
    expertsByStatus: rows
      .map((row) => ({ status: row.status as string, count: row._count }))
      .sort((a, b) => b.count - a.count),
    totalExperts: rows.reduce((total, row) => total + row._count, 0),
  };
}

async function demoProjects(db: Db): Promise<DemoProject[]> {
  const rows = await db.project.findMany({
    where: syntheticNameFilter('title'),
    select: {
      code: true,
      title: true,
      status: true,
      seatsFilled: true,
      seatsRequested: true,
      maxHourlyRateCents: true,
      requirements: { select: { required: true, skill: { select: { name: true } } } },
    },
    orderBy: { code: 'asc' },
  });

  return rows.map((row) => ({
    code: row.code,
    title: row.title,
    status: row.status as string,
    seatsFilled: row.seatsFilled,
    seatsRequested: row.seatsRequested,
    maxHourlyRateCents: row.maxHourlyRateCents,
    requirements: row.requirements
      .filter((requirement) => requirement.required)
      .map((requirement) => requirement.skill.name),
  }));
}

/**
 * One worked match run, which is the part of this product worth showing.
 *
 * Candidates are identified by reference and score. No name, no address, no
 * rate — a reference is enough to see that the ranking is stable and explained,
 * which is the claim being demonstrated.
 */
async function demoRanking(db: Db): Promise<DemoRanking | null> {
  const project = await db.project.findFirst({
    where: syntheticNameFilter('title'),
    select: { id: true, code: true, title: true },
    orderBy: { code: 'asc' },
  });
  if (!project) return null;

  const run = await db.matchRun.findFirst({
    where: { projectId: project.id },
    select: {
      id: true,
      algorithmVersion: true,
      consideredCount: true,
      candidateCount: true,
      excludedCount: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!run) return null;

  const candidates = await db.matchCandidate.findMany({
    where: { matchRunId: run.id },
    select: {
      rank: true,
      score: true,
      excluded: true,
      exclusionReason: true,
      expert: { select: { reference: true, fullName: true } },
    },
    orderBy: { score: 'desc' },
    take: 200,
  });

  // Belt and braces: even inside a match run, only synthetic people are shown.
  const synthetic = candidates.filter((candidate) =>
    SYNTHETIC_PREFIXES.some((prefix) => candidate.expert.fullName.startsWith(prefix)),
  );

  const reasons = new Map<string, number>();
  for (const candidate of synthetic) {
    if (!candidate.excluded || !candidate.exclusionReason) continue;
    const reason = candidate.exclusionReason.replace(/\d+/g, 'N');
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }

  return {
    projectCode: project.code,
    projectTitle: project.title,
    algorithmVersion: run.algorithmVersion,
    consideredCount: run.consideredCount,
    rankedCount: run.candidateCount,
    excludedCount: run.excludedCount,
    top: synthetic
      .filter((candidate) => !candidate.excluded)
      .slice(0, 8)
      .map((candidate) => ({
        reference: candidate.expert.reference,
        rank: candidate.rank,
        score: candidate.score,
      })),
    exclusions: [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  };
}

export async function demoOverview(db: Db): Promise<DemoOverview> {
  const [network, projects, ranking, openOpportunities, jobsSucceeded, jobsFailed] =
    await Promise.all([
      demoNetwork(db),
      demoProjects(db),
      demoRanking(db),
      db.opportunity.count({ where: { status: 'PUBLISHED' } }),
      db.job.count({ where: { status: 'SUCCEEDED' } }),
      db.job.count({ where: { status: { in: ['FAILED', 'DEAD'] } } }),
    ]);

  return { network, projects, ranking, openOpportunities, jobsSucceeded, jobsFailed };
}
