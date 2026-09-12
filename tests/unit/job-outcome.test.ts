import { describe, expect, it } from 'vitest';
import { describeJobOutcome } from '@/lib/job-outcome';

/**
 * "Succeeded" answers whether a job ran. The operator is asking whether
 * anything happened.
 *
 * The defect: the worker screen showed a green success badge beside
 * `{"attempted":0,"delivered":0,"simulated":true}`, which reads at a glance as
 * delivered email. It is a scan that found nothing to do.
 */
describe('describing what a finished job actually did', () => {
  it('calls a dispatcher run with nothing to send exactly that', () => {
    const outcome = describeJobOutcome({ attempted: 0, delivered: 0, simulated: true });
    expect(outcome.effect).toBe('no-effect');
    expect(outcome.summary).toBe('ran, nothing to do');
    expect(outcome.summary).not.toMatch(/delivered/);
  });

  it('reports the counts when a run did something', () => {
    const outcome = describeJobOutcome({ attempted: 3, delivered: 3, simulated: true });
    expect(outcome.effect).toBe('effect');
    expect(outcome.summary).toBe('3 delivered');
  });

  it('reads a handler that says plainly it skipped', () => {
    const outcome = describeJobOutcome({ sent: false, skipped: 'screening is DECIDED' });
    expect(outcome.effect).toBe('no-effect');
    expect(outcome.summary).toMatch(/nothing to do: screening is DECIDED/);
  });

  it('says nothing rather than guessing when the result has no counters', () => {
    expect(describeJobOutcome({ simulated: true }).effect).toBe('unknown');
    expect(describeJobOutcome({ simulated: true }).summary).toBeNull();
    expect(describeJobOutcome(null).effect).toBe('unknown');
    expect(describeJobOutcome('done').effect).toBe('unknown');
  });

  it('combines several counters, naming each', () => {
    const outcome = describeJobOutcome({ reminded: 2, expired: 0, escalated: 1 });
    expect(outcome.effect).toBe('effect');
    expect(outcome.summary).toBe('2 reminded, 1 escalated');
  });

  it('splits camel-case counters into readable words', () => {
    expect(describeJobOutcome({ prunedJobs: 4 }).summary).toBe('4 pruned jobs');
  });
});
