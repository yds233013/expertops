import {
  type AssignmentStatus,
  type ExpertStatus,
  type InvitationStatus,
  type OnboardingStatus,
  type ProjectStatus,
} from '@prisma/client';
import { invalidState } from '@/lib/errors';

/**
 * Every status transition in the product is declared here, once.
 *
 * Services call `assertTransition` before writing. Route handlers and the
 * worker never re-check a transition themselves - if a rule needs to change it
 * changes in this file and both callers pick it up.
 */
export type TransitionMap<T extends string> = Readonly<Record<T, readonly T[]>>;

export const PROJECT_TRANSITIONS: TransitionMap<ProjectStatus> = {
  DRAFT: ['MATCHING', 'CANCELLED'],
  MATCHING: ['DRAFT', 'INVITING', 'CANCELLED'],
  INVITING: ['MATCHING', 'STAFFING', 'CANCELLED'],
  STAFFING: ['INVITING', 'ACTIVE', 'CLOSED', 'CANCELLED'],
  ACTIVE: ['STAFFING', 'CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

export const EXPERT_TRANSITIONS: TransitionMap<ExpertStatus> = {
  PROSPECT: ['ONBOARDING', 'ARCHIVED'],
  ONBOARDING: ['PENDING_VERIFICATION', 'PROSPECT', 'ARCHIVED'],
  PENDING_VERIFICATION: ['VERIFIED', 'REJECTED', 'ONBOARDING', 'ARCHIVED'],
  VERIFIED: ['ARCHIVED', 'ONBOARDING'],
  REJECTED: ['ONBOARDING', 'ARCHIVED'],
  ARCHIVED: ['PROSPECT'],
};

export const INVITATION_TRANSITIONS: TransitionMap<InvitationStatus> = {
  DRAFT: ['SENT', 'WITHDRAWN'],
  SENT: ['ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'],
  ACCEPTED: [],
  DECLINED: ['DRAFT'],
  EXPIRED: ['DRAFT'],
  WITHDRAWN: ['DRAFT'],
};

export const ONBOARDING_TRANSITIONS: TransitionMap<OnboardingStatus> = {
  NOT_STARTED: ['IN_PROGRESS'],
  IN_PROGRESS: ['SUBMITTED'],
  SUBMITTED: ['VERIFIED', 'REJECTED'],
  VERIFIED: [],
  REJECTED: ['IN_PROGRESS'],
};

export const ASSIGNMENT_TRANSITIONS: TransitionMap<AssignmentStatus> = {
  PROPOSED: ['CONFIRMED', 'RELEASED'],
  CONFIRMED: ['RELEASED', 'COMPLETED'],
  RELEASED: ['PROPOSED'],
  COMPLETED: [],
};

export function canTransition<T extends string>(map: TransitionMap<T>, from: T, to: T): boolean {
  return (map[from] ?? []).includes(to);
}

export function assertTransition<T extends string>(
  entity: string,
  map: TransitionMap<T>,
  from: T,
  to: T,
): void {
  if (from === to) {
    throw invalidState(`${entity} is already ${from}.`, { from, to });
  }
  if (!canTransition(map, from, to)) {
    const allowed = map[from] ?? [];
    throw invalidState(
      allowed.length === 0
        ? `${entity} is ${from}, which is a terminal state and cannot change.`
        : `${entity} cannot move from ${from} to ${to}. Allowed: ${allowed.join(', ')}.`,
      { from, to, allowed },
    );
  }
}

/** Statuses in which a project may have matching run against it. */
export const PROJECT_STATUSES_OPEN_FOR_MATCHING: readonly ProjectStatus[] = [
  'MATCHING',
  'INVITING',
  'STAFFING',
];

/** Statuses in which an operator may send invitations. */
export const PROJECT_STATUSES_OPEN_FOR_INVITATIONS: readonly ProjectStatus[] = [
  'MATCHING',
  'INVITING',
  'STAFFING',
];

/** Statuses in which an operator may create or confirm assignments. */
export const PROJECT_STATUSES_OPEN_FOR_STAFFING: readonly ProjectStatus[] = [
  'INVITING',
  'STAFFING',
  'ACTIVE',
];

/** Invitation statuses that block a second invitation to the same expert. */
export const INVITATION_STATUSES_BLOCKING_REINVITE: readonly InvitationStatus[] = [
  'DRAFT',
  'SENT',
  'ACCEPTED',
];

/** Assignment statuses that consume a project seat. */
export const SEAT_CONSUMING_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = [
  'CONFIRMED',
  'COMPLETED',
];

/** The only expert status from which staffing is permitted. */
export const STAFFABLE_EXPERT_STATUS: ExpertStatus = 'VERIFIED';
