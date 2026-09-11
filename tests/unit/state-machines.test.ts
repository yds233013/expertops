import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  ASSIGNMENT_TRANSITIONS,
  assertTransition,
  canTransition,
  EXPERT_TRANSITIONS,
  INVITATION_TRANSITIONS,
  ONBOARDING_TRANSITIONS,
  PROJECT_TRANSITIONS,
  SEAT_CONSUMING_ASSIGNMENT_STATUSES,
  STAFFABLE_EXPERT_STATUS,
} from '@/server/domain/state-machines';

describe('workflow state machines', () => {
  it('allows the happy-path project progression', () => {
    expect(canTransition(PROJECT_TRANSITIONS, 'DRAFT', 'MATCHING')).toBe(true);
    expect(canTransition(PROJECT_TRANSITIONS, 'MATCHING', 'INVITING')).toBe(true);
    expect(canTransition(PROJECT_TRANSITIONS, 'INVITING', 'STAFFING')).toBe(true);
    expect(canTransition(PROJECT_TRANSITIONS, 'STAFFING', 'ACTIVE')).toBe(true);
  });

  it('forbids skipping straight from draft to active', () => {
    expect(canTransition(PROJECT_TRANSITIONS, 'DRAFT', 'ACTIVE')).toBe(false);
  });

  it('treats CLOSED and CANCELLED as terminal', () => {
    expect(PROJECT_TRANSITIONS.CLOSED).toEqual([]);
    expect(PROJECT_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('makes an accepted invitation terminal', () => {
    expect(INVITATION_TRANSITIONS.ACCEPTED).toEqual([]);
    expect(canTransition(INVITATION_TRANSITIONS, 'ACCEPTED', 'DECLINED')).toBe(false);
  });

  it('allows a declined or expired invitation to be reopened as a draft', () => {
    expect(canTransition(INVITATION_TRANSITIONS, 'DECLINED', 'DRAFT')).toBe(true);
    expect(canTransition(INVITATION_TRANSITIONS, 'EXPIRED', 'DRAFT')).toBe(true);
    expect(canTransition(INVITATION_TRANSITIONS, 'WITHDRAWN', 'DRAFT')).toBe(true);
  });

  it('requires a submitted case before a verification decision', () => {
    expect(canTransition(ONBOARDING_TRANSITIONS, 'IN_PROGRESS', 'VERIFIED')).toBe(false);
    expect(canTransition(ONBOARDING_TRANSITIONS, 'SUBMITTED', 'VERIFIED')).toBe(true);
    expect(canTransition(ONBOARDING_TRANSITIONS, 'SUBMITTED', 'REJECTED')).toBe(true);
  });

  it('lets a returned onboarding case be reworked but not a verified one', () => {
    expect(canTransition(ONBOARDING_TRANSITIONS, 'REJECTED', 'IN_PROGRESS')).toBe(true);
    expect(ONBOARDING_TRANSITIONS.VERIFIED).toEqual([]);
  });

  it('only allows an expert to become verified from pending verification', () => {
    expect(canTransition(EXPERT_TRANSITIONS, 'PENDING_VERIFICATION', 'VERIFIED')).toBe(true);
    expect(canTransition(EXPERT_TRANSITIONS, 'PROSPECT', 'VERIFIED')).toBe(false);
    expect(canTransition(EXPERT_TRANSITIONS, 'ONBOARDING', 'VERIFIED')).toBe(false);
  });

  it('requires a proposal before an assignment can be confirmed', () => {
    expect(canTransition(ASSIGNMENT_TRANSITIONS, 'PROPOSED', 'CONFIRMED')).toBe(true);
    expect(canTransition(ASSIGNMENT_TRANSITIONS, 'RELEASED', 'CONFIRMED')).toBe(false);
    expect(ASSIGNMENT_TRANSITIONS.COMPLETED).toEqual([]);
  });

  it('counts only confirmed and completed assignments against seats', () => {
    expect(SEAT_CONSUMING_ASSIGNMENT_STATUSES).toContain('CONFIRMED');
    expect(SEAT_CONSUMING_ASSIGNMENT_STATUSES).toContain('COMPLETED');
    expect(SEAT_CONSUMING_ASSIGNMENT_STATUSES).not.toContain('PROPOSED');
    expect(SEAT_CONSUMING_ASSIGNMENT_STATUSES).not.toContain('RELEASED');
  });

  it('names VERIFIED as the only staffable expert status', () => {
    expect(STAFFABLE_EXPERT_STATUS).toBe('VERIFIED');
  });
});

describe('assertTransition', () => {
  it('passes a legal transition through silently', () => {
    expect(() =>
      assertTransition('Project', PROJECT_TRANSITIONS, 'DRAFT', 'MATCHING'),
    ).not.toThrow();
  });

  it('rejects an illegal transition and lists what is allowed', () => {
    try {
      assertTransition('Project', PROJECT_TRANSITIONS, 'DRAFT', 'ACTIVE');
      throw new Error('expected assertTransition to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('INVALID_STATE');
      expect(appError.message).toContain('Allowed: MATCHING, CANCELLED');
    }
  });

  it('explains that a terminal state cannot change', () => {
    try {
      assertTransition('Invitation', INVITATION_TRANSITIONS, 'ACCEPTED', 'DECLINED');
      throw new Error('expected assertTransition to throw');
    } catch (error) {
      expect((error as AppError).message).toContain('terminal state');
    }
  });

  it('rejects a no-op transition rather than silently succeeding', () => {
    try {
      assertTransition('Project', PROJECT_TRANSITIONS, 'MATCHING', 'MATCHING');
      throw new Error('expected assertTransition to throw');
    } catch (error) {
      expect((error as AppError).message).toContain('already MATCHING');
    }
  });
});
