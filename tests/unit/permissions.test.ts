import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  assertCapability,
  capabilitiesFor,
  ROLE_CAPABILITIES,
  roleHasCapability,
} from '@/server/auth/permissions';

describe('operator access control', () => {
  it('gives a viewer read access but no write capability', () => {
    expect(roleHasCapability('VIEWER', 'project:read')).toBe(true);
    expect(roleHasCapability('VIEWER', 'expert:read')).toBe(true);
    expect(roleHasCapability('VIEWER', 'project:write')).toBe(false);
    expect(roleHasCapability('VIEWER', 'invitation:send')).toBe(false);
    expect(roleHasCapability('VIEWER', 'staffing:confirm')).toBe(false);
    expect(roleHasCapability('VIEWER', 'onboarding:verify')).toBe(false);
  });

  it('lets an operator run the whole staffing workflow', () => {
    for (const capability of [
      'project:write',
      'matching:run',
      'invitation:send',
      'onboarding:verify',
      'staffing:propose',
      'staffing:confirm',
      'staffing:release',
    ] as const) {
      expect(roleHasCapability('OPERATOR', capability)).toBe(true);
    }
  });

  it('reserves job and user administration for admins', () => {
    expect(roleHasCapability('OPERATOR', 'jobs:manage')).toBe(false);
    expect(roleHasCapability('OPERATOR', 'user:manage')).toBe(false);
    expect(roleHasCapability('ADMIN', 'jobs:manage')).toBe(true);
    expect(roleHasCapability('ADMIN', 'user:manage')).toBe(true);
  });

  it('makes each role a superset of the one below it', () => {
    for (const capability of ROLE_CAPABILITIES.VIEWER) {
      expect(ROLE_CAPABILITIES.OPERATOR).toContain(capability);
    }
    for (const capability of ROLE_CAPABILITIES.OPERATOR) {
      expect(ROLE_CAPABILITIES.ADMIN).toContain(capability);
    }
  });

  it('throws a FORBIDDEN error naming the capability', () => {
    try {
      assertCapability({ role: 'VIEWER' }, 'staffing:confirm');
      throw new Error('expected assertCapability to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('FORBIDDEN');
      expect((error as AppError).status).toBe(403);
      expect((error as AppError).message).toContain('staffing:confirm');
    }
  });

  it('returns a copy of the capability list so callers cannot mutate the table', () => {
    const list = capabilitiesFor('VIEWER');
    list.push('user:manage');
    expect(roleHasCapability('VIEWER', 'user:manage')).toBe(false);
  });
});
