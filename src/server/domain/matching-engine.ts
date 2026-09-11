import { workingHoursOverlap } from '@/lib/timezone';

/**
 * Deterministic candidate scoring.
 *
 * This module is intentionally pure: no database, no clock (the caller passes
 * `now`), no randomness. The same inputs always produce the same ranking, which
 * is what makes a match run reproducible and explainable to an operator.
 *
 * No language model, no external API, and no protected personal attribute is
 * involved. The only inputs are declared skills, seniority, rate, working-hours
 * overlap, network standing, and recent engagement history.
 */
export const ALGORITHM_VERSION = 'rules-v1';

export interface MatchWeights {
  requiredSkills: number;
  optionalSkills: number;
  seniority: number;
  rate: number;
  availability: number;
  standing: number;
}

export const DEFAULT_WEIGHTS: MatchWeights = {
  requiredSkills: 35,
  optionalSkills: 20,
  seniority: 15,
  rate: 12,
  availability: 10,
  standing: 8,
};

export function totalWeight(weights: MatchWeights): number {
  return (
    weights.requiredSkills +
    weights.optionalSkills +
    weights.seniority +
    weights.rate +
    weights.availability +
    weights.standing
  );
}

export interface CandidateSkill {
  slug: string;
  proficiency: number;
  yearsUsed: number;
}

export type CandidateStatus =
  'PROSPECT' | 'ONBOARDING' | 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED' | 'ARCHIVED';

export interface CandidateInput {
  expertId: string;
  status: CandidateStatus;
  yearsExperience: number;
  hourlyRateCents: number;
  timezone: string;
  weeklyCapacityHours: number;
  skills: CandidateSkill[];
  /** Set when the expert already holds an active invitation for this project. */
  hasOpenInvitationForProject: boolean;
  /** Set when the expert already holds a seat on this project. */
  isAssignedToProject: boolean;
  /** Most recent decline of any project, used as a short cool-off signal. */
  lastDeclinedAt: Date | null;
  /** Count of confirmed seats the expert currently holds across all projects. */
  activeAssignmentCount: number;
}

export interface SkillRequirement {
  slug: string;
  required: boolean;
  minProficiency: number;
  weight: number;
}

export interface ProjectCriteria {
  minYearsExperience: number;
  maxHourlyRateCents: number | null;
  preferredTimezone: string;
  requirements: SkillRequirement[];
  /** Weekly hours a seat needs; used as a soft availability signal. */
  hoursPerWeekNeeded: number;
}

export interface ScoreBreakdown {
  requiredSkills: number;
  optionalSkills: number;
  seniority: number;
  rate: number;
  availability: number;
  standing: number;
  penalties: number;
  notes: string[];
}

export interface ScoredCandidate {
  expertId: string;
  score: number;
  breakdown: ScoreBreakdown;
  excluded: boolean;
  exclusionReason: string | null;
}

export const DECLINE_COOLOFF_DAYS = 14;

const STANDING_BY_STATUS: Record<CandidateStatus, number> = {
  VERIFIED: 1,
  PENDING_VERIFICATION: 0.75,
  ONBOARDING: 0.5,
  PROSPECT: 0.35,
  REJECTED: 0,
  ARCHIVED: 0,
};

/** Statuses that can never appear in a match run. */
const HARD_EXCLUDED_STATUSES: CandidateStatus[] = ['ARCHIVED', 'REJECTED'];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Hard filters. Returning a reason here means the expert is recorded on the run
 * as excluded (so the operator can see who was skipped and why) but is never
 * offered as a candidate.
 */
export function evaluateExclusion(
  candidate: CandidateInput,
  criteria: ProjectCriteria,
  now: Date,
): string | null {
  if (HARD_EXCLUDED_STATUSES.includes(candidate.status)) {
    return `Expert status is ${candidate.status}`;
  }
  if (candidate.isAssignedToProject) {
    return 'Already assigned to this project';
  }
  if (candidate.hasOpenInvitationForProject) {
    return 'Already has an open invitation for this project';
  }

  const held = new Set(candidate.skills.filter((s) => s.proficiency >= 1).map((s) => s.slug));
  const missing = criteria.requirements
    .filter((requirement) => requirement.required)
    .filter((requirement) => {
      const owned = candidate.skills.find((s) => s.slug === requirement.slug);
      return !owned || owned.proficiency < requirement.minProficiency;
    });
  if (missing.length > 0) {
    return `Missing required skill(s): ${missing.map((m) => m.slug).join(', ')}`;
  }
  if (!held.size && criteria.requirements.length > 0) {
    return 'No overlapping skills recorded';
  }

  if (candidate.yearsExperience < criteria.minYearsExperience) {
    return `Below minimum experience (${candidate.yearsExperience} < ${criteria.minYearsExperience} years)`;
  }

  if (candidate.lastDeclinedAt) {
    const days = (now.getTime() - candidate.lastDeclinedAt.getTime()) / 86_400_000;
    if (days < DECLINE_COOLOFF_DAYS) {
      return `Declined another invitation ${Math.floor(days)} day(s) ago (cool-off is ${DECLINE_COOLOFF_DAYS} days)`;
    }
  }

  return null;
}

export function scoreCandidate(
  candidate: CandidateInput,
  criteria: ProjectCriteria,
  weights: MatchWeights = DEFAULT_WEIGHTS,
  now: Date = new Date(),
): ScoredCandidate {
  const exclusion = evaluateExclusion(candidate, criteria, now);
  const notes: string[] = [];

  const bySlug = new Map(candidate.skills.map((s) => [s.slug, s]));
  const required = criteria.requirements.filter((r) => r.required);
  const optional = criteria.requirements.filter((r) => !r.required);

  // --- required skills: depth beyond the minimum, weighted -----------------
  let requiredScore = 1;
  if (required.length > 0) {
    let earned = 0;
    let possible = 0;
    for (const requirement of required) {
      const owned = bySlug.get(requirement.slug);
      possible += requirement.weight;
      if (!owned) continue;
      // 1.0 at the minimum, scaling to 1.0 at proficiency 5; never above 1.
      const headroom = 5 - requirement.minProficiency;
      const depth =
        headroom <= 0 ? 1 : clamp01((owned.proficiency - requirement.minProficiency) / headroom);
      earned += requirement.weight * (0.7 + 0.3 * depth);
    }
    requiredScore = possible > 0 ? clamp01(earned / possible) : 1;
  }

  // --- optional skills: pure coverage bonus --------------------------------
  let optionalScore = 0;
  if (optional.length > 0) {
    let earned = 0;
    let possible = 0;
    for (const requirement of optional) {
      possible += requirement.weight;
      const owned = bySlug.get(requirement.slug);
      if (!owned) continue;
      if (owned.proficiency < requirement.minProficiency) {
        earned += requirement.weight * 0.4;
        continue;
      }
      const headroom = 5 - requirement.minProficiency;
      const depth =
        headroom <= 0 ? 1 : clamp01((owned.proficiency - requirement.minProficiency) / headroom);
      earned += requirement.weight * (0.75 + 0.25 * depth);
    }
    optionalScore = possible > 0 ? clamp01(earned / possible) : 0;
  } else {
    optionalScore = 1; // nothing optional asked for: do not punish anyone
  }

  // --- seniority: meeting the bar is full marks, more is mildly better -----
  const minYears = Math.max(criteria.minYearsExperience, 1);
  const seniorityScore = clamp01(candidate.yearsExperience / (minYears * 2));

  // --- rate: at or under budget is full marks, over decays to zero ---------
  let rateScore = 1;
  if (criteria.maxHourlyRateCents && criteria.maxHourlyRateCents > 0) {
    if (candidate.hourlyRateCents <= criteria.maxHourlyRateCents) {
      rateScore = 1;
    } else {
      const overBy = candidate.hourlyRateCents / criteria.maxHourlyRateCents - 1;
      // 25% over budget scores 0.
      rateScore = clamp01(1 - overBy / 0.25);
      notes.push(`Rate is ${Math.round(overBy * 100)}% above the project ceiling`);
    }
  }

  // --- availability: working-hours overlap + declared weekly capacity ------
  const overlapHours = workingHoursOverlap(candidate.timezone, criteria.preferredTimezone, now);
  const overlapScore = clamp01(overlapHours / 6); // 6+ hours of overlap is full marks
  const capacityScore =
    criteria.hoursPerWeekNeeded > 0
      ? clamp01(candidate.weeklyCapacityHours / criteria.hoursPerWeekNeeded)
      : 1;
  const availabilityScore = 0.6 * overlapScore + 0.4 * capacityScore;
  if (overlapHours < 2) {
    notes.push(`Only ${overlapHours.toFixed(1)}h of working-hours overlap`);
  }

  // --- standing: how far through the network lifecycle the expert is -------
  let standingScore = STANDING_BY_STATUS[candidate.status];
  if (candidate.activeAssignmentCount >= 2) {
    standingScore *= 0.6;
    notes.push(`Already holds ${candidate.activeAssignmentCount} confirmed seats`);
  } else if (candidate.activeAssignmentCount === 1) {
    standingScore *= 0.85;
  }

  const breakdown: ScoreBreakdown = {
    requiredSkills: round2(requiredScore * weights.requiredSkills),
    optionalSkills: round2(optionalScore * weights.optionalSkills),
    seniority: round2(seniorityScore * weights.seniority),
    rate: round2(rateScore * weights.rate),
    availability: round2(availabilityScore * weights.availability),
    standing: round2(standingScore * weights.standing),
    penalties: 0,
    notes,
  };

  const raw =
    breakdown.requiredSkills +
    breakdown.optionalSkills +
    breakdown.seniority +
    breakdown.rate +
    breakdown.availability +
    breakdown.standing;

  const normalised = (raw / totalWeight(weights)) * 100;

  return {
    expertId: candidate.expertId,
    score: Math.max(0, Math.min(100, Math.round(normalised))),
    breakdown,
    excluded: exclusion !== null,
    exclusionReason: exclusion,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Rank a candidate pool.
 *
 * Ties break on expertId so two runs over the same data always produce the same
 * order - a property the integration tests rely on.
 */
export function rankCandidates(
  candidates: CandidateInput[],
  criteria: ProjectCriteria,
  weights: MatchWeights = DEFAULT_WEIGHTS,
  now: Date = new Date(),
): ScoredCandidate[] {
  return candidates
    .map((candidate) => scoreCandidate(candidate, criteria, weights, now))
    .sort((a, b) => {
      if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
      if (b.score !== a.score) return b.score - a.score;
      return a.expertId.localeCompare(b.expertId);
    });
}
