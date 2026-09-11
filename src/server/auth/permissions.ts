import { type UserRole } from '@prisma/client';
import { forbidden } from '@/lib/errors';

/**
 * Operator access control.
 *
 * One capability list per role. Every guarded action names a capability rather
 * than testing a role inline, so adding a role does not mean auditing call
 * sites.
 */
export const CAPABILITIES = [
  'expert:read',
  'expert:write',
  'project:read',
  'project:write',
  'project:status',
  'matching:run',
  'invitation:send',
  'invitation:withdraw',
  'onboarding:read',
  'onboarding:verify',
  'staffing:propose',
  'staffing:confirm',
  'staffing:release',
  'activity:read',
  'outbox:read',
  'jobs:read',
  'jobs:manage',
  'user:manage',
  // --- extension ---------------------------------------------------------
  'candidate:read',
  'candidate:write',
  'campaign:read',
  'campaign:write',
  'screening:read',
  'screening:write',
  'screening:review',
  'screening:decide',
  'screening:resolve_conflict',
  'rubric:read',
  'rubric:write',
  'rubric:publish',
  'qualification:read',
  'qualification:write',
  'outreach:read',
  'outreach:write',
  'outreach:approve',
  'attention:read',
  'attention:manage',
  'work:read',
  'work:write',
  'work:review',
  'support:read',
  'support:respond',
  'payment:read',
  'payment:write',
  'payment:approve',
  'offboarding:read',
  'offboarding:confirm',
  'import:run',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const VIEWER: Capability[] = [
  'expert:read',
  'project:read',
  'onboarding:read',
  'activity:read',
  'outbox:read',
  'jobs:read',
  'candidate:read',
  'campaign:read',
  'screening:read',
  'rubric:read',
  'qualification:read',
  'outreach:read',
  'attention:read',
  'work:read',
  'support:read',
  'payment:read',
  'offboarding:read',
];

const OPERATOR: Capability[] = [
  ...VIEWER,
  'expert:write',
  'project:write',
  'project:status',
  'matching:run',
  'invitation:send',
  'invitation:withdraw',
  'onboarding:verify',
  'staffing:propose',
  'staffing:confirm',
  'staffing:release',
  'candidate:write',
  'campaign:write',
  'screening:write',
  'screening:review',
  'screening:decide',
  'rubric:write',
  'qualification:write',
  'outreach:write',
  'attention:manage',
  'work:write',
  'work:review',
  'support:respond',
  'payment:write',
  'offboarding:confirm',
  'import:run',
];

/**
 * Decisions reserved for an admin.
 *
 * These are the ones where a second pair of eyes is the point: publishing an
 * immutable rubric, breaking a reviewer tie, approving bulk outreach, and
 * approving a payment batch that becomes money somewhere else.
 */
const ADMIN: Capability[] = [
  ...OPERATOR,
  'jobs:manage',
  'user:manage',
  'rubric:publish',
  'screening:resolve_conflict',
  'outreach:approve',
  'payment:approve',
];

export const ROLE_CAPABILITIES: Record<UserRole, readonly Capability[]> = {
  VIEWER: VIEWER,
  OPERATOR: OPERATOR,
  ADMIN: ADMIN,
};

export function roleHasCapability(role: UserRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export function assertCapability(
  actor: { role: UserRole; email?: string },
  capability: Capability,
): void {
  if (!roleHasCapability(actor.role, capability)) {
    throw forbidden(`Role ${actor.role} is not allowed to perform "${capability}".`);
  }
}

export function capabilitiesFor(role: UserRole): Capability[] {
  return [...ROLE_CAPABILITIES[role]];
}
