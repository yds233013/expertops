import type { AccessGrantStatus, AccessSystem } from '@prisma/client';

/**
 * Words for access grants, shared by the operator pages and the portal.
 * Pure, so a client component can use it.
 */

export const SYSTEM_LABEL: Record<AccessSystem, string> = {
  GITHUB: 'GitHub',
  SLACK: 'Slack',
};

/** What turns a simulated system live. */
export const SYSTEM_TOKEN: Record<AccessSystem, string> = {
  GITHUB: 'GITHUB_ADMIN_TOKEN',
  SLACK: 'SLACK_BOT_TOKEN',
};

/** Problems first: a failed revoke may mean someone still has access. */
export const STATUS_ORDER: AccessGrantStatus[] = [
  'REVOKE_FAILED',
  'GRANT_FAILED',
  'REVOKING',
  'PENDING',
  'ACTIVE',
  'REVOKED',
];

export const STATUS_HELP: Record<AccessGrantStatus, string> = {
  PENDING: 'Wanted and not granted yet. The next check grants it.',
  ACTIVE: 'Granted.',
  REVOKING: 'Must be removed. The next check removes it.',
  REVOKED: 'Removed.',
  GRANT_FAILED: 'Granting stopped. Nothing was granted. Fix the cause, then retry.',
  REVOKE_FAILED: 'Removing failed. They may still have access.',
};

export function byStatusThenRecent<T extends { status: AccessGrantStatus; updatedAt: Date }>(
  a: T,
  b: T,
): number {
  const rank = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  return rank !== 0 ? rank : b.updatedAt.getTime() - a.updatedAt.getTime();
}

/** "acme/eval-harness" or "#eval-wave-1". */
export function resourceName(resource: {
  system: AccessSystem;
  resource: string;
  label: string;
}): string {
  if (resource.system === 'GITHUB') return resource.resource;
  return resource.label || resource.resource;
}

/**
 * The expert's view of a grant, in plain words. No error text: that is for
 * the team to act on, and it can name tokens and settings.
 */
export function expertStatusText(status: AccessGrantStatus, invitationPending: boolean): string {
  switch (status) {
    case 'ACTIVE':
      return invitationPending ? 'Invited: accept it on GitHub' : 'You have access';
    case 'PENDING':
      return 'Being set up';
    case 'GRANT_FAILED':
      return 'Not set up yet';
    case 'REVOKING':
    case 'REVOKE_FAILED':
      return 'Being removed';
    case 'REVOKED':
      return 'Removed';
  }
}
