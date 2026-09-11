import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_GATES,
  AUTOMATION_RULES,
  REMINDER_POLICY,
  ruleFor,
  rulesProducingOutreach,
  rulesRequiringApproval,
} from '@/server/domain/automation';
import { HANDLERS } from '@/server/worker/handlers';
import { JOB_TYPES } from '@/server/services/jobs';
import { DEFAULT_SCHEDULES } from '@/server/services/schedules';
import { CAPABILITIES } from '@/server/auth/permissions';

/**
 * The automation map is documentation that the code has to agree with.
 *
 * `docs/automation.md` describes the same rules in prose. These tests stop the
 * two drifting apart, and stop a rule being declared without anything behind
 * it.
 */
describe('the automation map matches the code', () => {
  it('schedules only job types that exist', () => {
    for (const rule of AUTOMATION_RULES) {
      if (rule.enqueues === null) continue;
      expect(JOB_TYPES, `${rule.id} schedules an unknown job`).toContain(rule.enqueues);
    }
  });

  it('schedules only job types that have a handler', () => {
    for (const rule of AUTOMATION_RULES) {
      if (rule.enqueues === null) continue;
      expect(HANDLERS[rule.enqueues], `${rule.id} has no handler`).toBeTypeOf('function');
    }
  });

  it('covers all ten required event-driven workflows', () => {
    const required = [
      'application-submitted',
      'screening-submitted',
      'review-overdue',
      'qualification-approved',
      'onboarding-verified',
      'assignment-confirmed',
      'expert-withdrawal',
      'work-submitted',
      'work-approved',
      'project-completed',
    ];
    for (const id of required) {
      expect(ruleFor(id), `missing automation rule "${id}"`).toBeDefined();
    }
    expect(AUTOMATION_RULES).toHaveLength(required.length);
  });

  it('gives every rule a description, a trigger and a stale-state check', () => {
    for (const rule of AUTOMATION_RULES) {
      expect(rule.trigger.length, `${rule.id} has no trigger`).toBeGreaterThan(0);
      expect(rule.description.length, `${rule.id} has no description`).toBeGreaterThan(0);
      // Every job may arrive late or twice, so every rule must say what it
      // re-checks before acting.
      expect(rule.staleCheck.length, `${rule.id} does not say what it rechecks`).toBeGreaterThan(0);
    }
  });

  it('names a human approver on every consequential rule', () => {
    const consequential = [
      'qualification-approved',
      'onboarding-verified',
      'assignment-confirmed',
      'expert-withdrawal',
      'work-approved',
      'project-completed',
    ];
    for (const id of consequential) {
      expect(ruleFor(id)!.humanApproval, `${id} has no named approver`).not.toBeNull();
    }
    expect(rulesRequiringApproval().length).toBeGreaterThanOrEqual(consequential.length);
  });

  it('marks the rules that reach a person', () => {
    const outreach = rulesProducingOutreach().map((rule) => rule.id);
    expect(outreach).toContain('application-submitted');
    expect(outreach).toContain('review-overdue');
    expect(outreach).toContain('expert-withdrawal');
    // A payment draft never contacts anybody.
    expect(outreach).not.toContain('work-approved');
  });
});

describe('approval gates', () => {
  it('names a capability that actually exists', () => {
    for (const gate of APPROVAL_GATES) {
      expect(CAPABILITIES, `${gate.id} names an unknown capability`).toContain(
        gate.capability as (typeof CAPABILITIES)[number],
      );
    }
  });

  it('covers every decision the requirements call consequential', () => {
    const ids = APPROVAL_GATES.map((gate) => gate.id);
    for (const required of [
      'screening-decision',
      'conflict-resolution',
      'duplicate-resolution',
      'onboarding-verification',
      'outreach-batch',
      'staffing-confirmation',
      'work-approval',
      'payment-discrepancy',
      'payment-batch',
      'offboarding-confirmation',
    ]) {
      expect(ids, `missing approval gate "${required}"`).toContain(required);
    }
  });

  it('states the rule for each gate, not just the name', () => {
    for (const gate of APPROVAL_GATES) {
      expect(gate.rule.length, `${gate.id} has no stated rule`).toBeGreaterThan(20);
      expect(gate.action.length).toBeGreaterThan(0);
    }
  });
});

describe('the reminder policy is real', () => {
  it('caps reminders and spaces them out', () => {
    expect(REMINDER_POLICY.maxReminders).toBeGreaterThan(0);
    expect(REMINDER_POLICY.maxReminders).toBeLessThanOrEqual(5);
    expect(REMINDER_POLICY.minIntervalHours).toBeGreaterThanOrEqual(1);
    expect(REMINDER_POLICY.suppressWithinHoursOfDeadline).toBeGreaterThan(0);
    expect(REMINDER_POLICY.respectsOptOut).toBe(true);
  });
});

describe('the job registry is honest', () => {
  it('has a handler for every declared job type, and no orphans', () => {
    const handlerTypes = Object.keys(HANDLERS).sort();
    expect(handlerTypes).toEqual([...JOB_TYPES].sort());
  });

  it('registers only schedules whose job type exists', () => {
    for (const schedule of DEFAULT_SCHEDULES) {
      expect(JOB_TYPES, `schedule ${schedule.name} is orphaned`).toContain(schedule.jobType);
      expect(schedule.description.length, `${schedule.name} has no description`).toBeGreaterThan(0);
      expect(schedule.intervalSeconds).toBeGreaterThan(0);
    }
  });

  it('contains no handler that reports success without doing anything', () => {
    const source = readFileSync('src/server/worker/handlers.ts', 'utf8');
    // The original build shipped two of these. They made the Worker screen look
    // healthier than the system was.
    expect(source).not.toContain('not implemented in this slice');
    expect(source).not.toContain('notified: false');
  });
});

describe('docs/automation.md agrees with the code', () => {
  const markdown = readFileSync('docs/automation.md', 'utf8');

  it('documents every scheduled sweep', () => {
    for (const schedule of DEFAULT_SCHEDULES) {
      expect(markdown, `docs do not mention schedule ${schedule.name}`).toContain(schedule.name);
    }
  });

  it('documents every approval gate', () => {
    for (const gate of APPROVAL_GATES) {
      expect(markdown, `docs do not mention capability ${gate.capability}`).toContain(
        gate.capability,
      );
    }
  });

  it('documents every event-driven job', () => {
    for (const rule of AUTOMATION_RULES) {
      if (rule.enqueues === null) continue;
      expect(markdown, `docs do not mention job ${rule.enqueues}`).toContain(rule.enqueues);
    }
  });

  it('states the reminder numbers the code actually uses', () => {
    expect(markdown).toContain(String(REMINDER_POLICY.maxReminders));
    expect(markdown).toContain(`${REMINDER_POLICY.minIntervalHours} hours`);
  });
});
