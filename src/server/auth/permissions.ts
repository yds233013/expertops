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
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const VIEWER: Capability[] = [
  'expert:read',
  'project:read',
  'onboarding:read',
  'activity:read',
  'outbox:read',
  'jobs:read',
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
];

const ADMIN: Capability[] = [...OPERATOR, 'jobs:manage', 'user:manage'];

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
