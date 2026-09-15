import { describe, expect, it } from 'vitest';
import {
  ALGORITHM_VERSION,
  DECLINE_COOLOFF_DAYS,
  DEFAULT_WEIGHTS,
  evaluateExclusion,
  rankCandidates,
  scoreCandidate,
  type CandidateInput,
  type ProjectCriteria,
} from '@/server/domain/matching-engine';

const NOW = new Date('2026-06-01T12:00:00Z');

function candidate(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    expertId: 'expert-1',
    status: 'VERIFIED',
    contactPreference: 'UNKNOWN',
    yearsExperience: 10,
    hourlyRateCents: 20_000,
    timezone: 'UTC',
    weeklyCapacityHours: 20,
    skills: [{ slug: 'distributed-systems', proficiency: 4, yearsUsed: 6 }],
    hasOpenInvitationForProject: false,
    isAssignedToProject: false,
    lastDeclinedAt: null,
    activeAssignmentCount: 0,
    ...overrides,
  };
}

function criteria(overrides: Partial<ProjectCriteria> = {}): ProjectCriteria {
  return {
    minYearsExperience: 5,
    maxHourlyRateCents: 25_000,
    preferredTimezone: 'UTC',
    hoursPerWeekNeeded: 20,
    requirements: [{ slug: 'distributed-systems', required: true, minProficiency: 3, weight: 4 }],
    ...overrides,
  };
}

describe('matching engine: scoring', () => {
  it('gives a well-matched candidate a high score', () => {
    const result = scoreCandidate(candidate(), criteria(), DEFAULT_WEIGHTS, NOW);
    expect(result.excluded).toBe(false);
    expect(result.score).toBeGreaterThan(80);
  });

  it('is deterministic: identical inputs produce an identical score', () => {
    const a = scoreCandidate(candidate(), criteria(), DEFAULT_WEIGHTS, NOW);
    const b = scoreCandidate(candidate(), criteria(), DEFAULT_WEIGHTS, NOW);
    expect(a).toEqual(b);
  });

  it('never returns a score outside 0..100', () => {
    const extremes = [
      candidate({ yearsExperience: 60, hourlyRateCents: 0, weeklyCapacityHours: 60 }),
      candidate({ yearsExperience: 5, hourlyRateCents: 900_000, weeklyCapacityHours: 0 }),
    ];
    for (const input of extremes) {
      const result = scoreCandidate(input, criteria(), DEFAULT_WEIGHTS, NOW);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });

  it('scores deeper proficiency above the bare minimum', () => {
    const shallow = scoreCandidate(
      candidate({ skills: [{ slug: 'distributed-systems', proficiency: 3, yearsUsed: 3 }] }),
      criteria(),
      DEFAULT_WEIGHTS,
      NOW,
    );
    const deep = scoreCandidate(
      candidate({ skills: [{ slug: 'distributed-systems', proficiency: 5, yearsUsed: 9 }] }),
      criteria(),
      DEFAULT_WEIGHTS,
      NOW,
    );
    expect(deep.score).toBeGreaterThan(shallow.score);
  });

  it('penalises a rate above the project ceiling and explains why', () => {
    const overBudget = scoreCandidate(
      candidate({ hourlyRateCents: 30_000 }),
      criteria({ maxHourlyRateCents: 25_000 }),
      DEFAULT_WEIGHTS,
      NOW,
    );
    const inBudget = scoreCandidate(candidate(), criteria(), DEFAULT_WEIGHTS, NOW);
    expect(overBudget.score).toBeLessThan(inBudget.score);
    expect(overBudget.breakdown.notes.join(' ')).toContain('above the project ceiling');
  });

  it('treats a rate at exactly the ceiling as fully in budget', () => {
    const result = scoreCandidate(
      candidate({ hourlyRateCents: 25_000 }),
      criteria({ maxHourlyRateCents: 25_000 }),
      DEFAULT_WEIGHTS,
      NOW,
    );
    expect(result.breakdown.rate).toBe(DEFAULT_WEIGHTS.rate);
    expect(result.breakdown.notes).toEqual([]);
  });

  it('rewards better working-hours overlap', () => {
    const aligned = scoreCandidate(
      candidate({ timezone: 'Europe/London' }),
      criteria({ preferredTimezone: 'Europe/London' }),
      DEFAULT_WEIGHTS,
      NOW,
    );
    const opposed = scoreCandidate(
      candidate({ timezone: 'Asia/Tokyo' }),
      criteria({ preferredTimezone: 'America/Los_Angeles' }),
      DEFAULT_WEIGHTS,
      NOW,
    );
    expect(aligned.breakdown.availability).toBeGreaterThan(opposed.breakdown.availability);
  });

  it('ranks a busy expert below an idle one, all else equal', () => {
    const idle = scoreCandidate(
      candidate({ activeAssignmentCount: 0 }),
      criteria(),
      DEFAULT_WEIGHTS,
      NOW,
    );
    const busy = scoreCandidate(
      candidate({ activeAssignmentCount: 3 }),
      criteria(),
      DEFAULT_WEIGHTS,
      NOW,
    );
    expect(busy.score).toBeLessThan(idle.score);
    expect(busy.breakdown.notes.join(' ')).toContain('confirmed seats');
  });

  it('ranks network standing: verified above prospect', () => {
    const verified = scoreCandidate(
      candidate({ status: 'VERIFIED' }),
      criteria(),
      DEFAULT_WEIGHTS,
      NOW,
    );
    const prospect = scoreCandidate(
      candidate({ status: 'PROSPECT' }),
      criteria(),
      DEFAULT_WEIGHTS,
      NOW,
    );
    expect(verified.score).toBeGreaterThan(prospect.score);
  });

  it('does not punish a candidate when the project lists no optional skills', () => {
    const result = scoreCandidate(
      candidate(),
      criteria({
        requirements: [
          { slug: 'distributed-systems', required: true, minProficiency: 3, weight: 4 },
        ],
      }),
      DEFAULT_WEIGHTS,
      NOW,
    );
    expect(result.breakdown.optionalSkills).toBe(DEFAULT_WEIGHTS.optionalSkills);
  });

  it('exposes a stable algorithm version for audit', () => {
    expect(ALGORITHM_VERSION).toBe('rules-v1');
  });
});

describe('matching engine: hard exclusions', () => {
  it('excludes an expert missing a required skill', () => {
    const reason = evaluateExclusion(
      candidate({ skills: [{ slug: 'pricing-strategy', proficiency: 5, yearsUsed: 8 }] }),
      criteria(),
      NOW,
    );
    expect(reason).toContain('Missing required skill');
  });

  it('excludes an expert whose required-skill proficiency is below the minimum', () => {
    const reason = evaluateExclusion(
      candidate({ skills: [{ slug: 'distributed-systems', proficiency: 2, yearsUsed: 1 }] }),
      criteria({
        requirements: [
          { slug: 'distributed-systems', required: true, minProficiency: 4, weight: 4 },
        ],
      }),
      NOW,
    );
    expect(reason).toContain('Missing required skill');
  });

  it('excludes an expert below the minimum experience bar', () => {
    const reason = evaluateExclusion(candidate({ yearsExperience: 2 }), criteria(), NOW);
    expect(reason).toContain('Below minimum experience');
  });

  it('excludes archived and rejected experts', () => {
    expect(evaluateExclusion(candidate({ status: 'ARCHIVED' }), criteria(), NOW)).toContain(
      'ARCHIVED',
    );
    expect(evaluateExclusion(candidate({ status: 'REJECTED' }), criteria(), NOW)).toContain(
      'REJECTED',
    );
  });

  it('excludes an expert already invited to or assigned on the project', () => {
    expect(
      evaluateExclusion(candidate({ hasOpenInvitationForProject: true }), criteria(), NOW),
    ).toContain('open invitation');
    expect(evaluateExclusion(candidate({ isAssignedToProject: true }), criteria(), NOW)).toContain(
      'Already assigned',
    );
  });

  it('applies a decline cool-off and releases it once it lapses', () => {
    const recent = new Date(NOW.getTime() - 3 * 86_400_000);
    expect(evaluateExclusion(candidate({ lastDeclinedAt: recent }), criteria(), NOW)).toContain(
      'cool-off',
    );

    const old = new Date(NOW.getTime() - (DECLINE_COOLOFF_DAYS + 1) * 86_400_000);
    expect(evaluateExclusion(candidate({ lastDeclinedAt: old }), criteria(), NOW)).toBeNull();
  });

  it('does not exclude a well-matched candidate', () => {
    expect(evaluateExclusion(candidate(), criteria(), NOW)).toBeNull();
  });
});

describe('matching engine: ranking', () => {
  it('orders by score, pushes exclusions last, and breaks ties on id', () => {
    const pool = [
      candidate({ expertId: 'b', hourlyRateCents: 24_000 }),
      candidate({ expertId: 'a', hourlyRateCents: 24_000 }),
      candidate({ expertId: 'c', yearsExperience: 1 }), // excluded
      candidate({
        expertId: 'd',
        skills: [{ slug: 'distributed-systems', proficiency: 5, yearsUsed: 9 }],
      }),
    ];

    const ranked = rankCandidates(pool, criteria(), DEFAULT_WEIGHTS, NOW);

    expect(ranked.at(-1)!.expertId).toBe('c');
    expect(ranked.at(-1)!.excluded).toBe(true);
    expect(ranked[0]!.expertId).toBe('d');
    // a and b are identical apart from id, so id breaks the tie.
    expect([ranked[1]!.expertId, ranked[2]!.expertId]).toEqual(['a', 'b']);
  });

  it('produces the same ranking for the same pool in a different input order', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      candidate({ expertId: id, yearsExperience: 8 }),
    );
    const forward = rankCandidates(pool, criteria(), DEFAULT_WEIGHTS, NOW).map((c) => c.expertId);
    const reversed = rankCandidates([...pool].reverse(), criteria(), DEFAULT_WEIGHTS, NOW).map(
      (c) => c.expertId,
    );
    expect(forward).toEqual(reversed);
  });

  it('handles an empty pool', () => {
    expect(rankCandidates([], criteria(), DEFAULT_WEIGHTS, NOW)).toEqual([]);
  });
});
