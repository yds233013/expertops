import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import { actorFor, makeOperator } from '../helpers/factories';
import {
  deactivateOperator,
  login,
  logout,
  purgeExpiredSessions,
  resolveSession,
  revokeSessionsFor,
  rotateOperatorPassword,
} from '@/server/services/auth';
import {
  EMAIL_ATTEMPT_LIMIT,
  IP_ATTEMPT_LIMIT,
  lockoutState,
  pruneLoginAttempts,
} from '@/server/services/login-protection';
import { AppError } from '@/lib/errors';
import { SYSTEM_ACTOR } from '@/server/services/activity';

/**
 * Sign-in abuse, session expiry, and session revocation.
 *
 * The gap these close: the login endpoint had no throttling at all. The
 * constant-time comparison hid *which* accounts exist, but nothing limited how
 * many passwords could be tried against one that does.
 */
/** Run something that must fail, and hand back the AppError it threw. */
async function expectFailure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
    throw new Error('expected this to fail, but it succeeded');
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return error;
  }
}

async function failLogin(email: string, clientIp?: string) {
  return expectFailure(login(prisma, { email, password: 'wrong-password', clientIp }));
}

describe('sign-in abuse protection', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('locks an address out after repeated failures, then lets it back in', async () => {
    const operator = await makeOperator();

    for (let attempt = 0; attempt < EMAIL_ATTEMPT_LIMIT; attempt += 1) {
      const error = await failLogin(operator.email);
      expect(error.code).toBe('UNAUTHENTICATED');
    }

    // The next attempt is refused before any password comparison happens, and
    // the correct password does not get through either.
    const locked = await failLogin(operator.email);
    expect(locked.code).toBe('RATE_LIMITED');
    expect(locked.message).toMatch(/Too many failed sign-in attempts/);

    const withRealPassword = await expectFailure(
      login(prisma, { email: operator.email, password: operator.plainPassword }),
    );
    expect(withRealPassword.code).toBe('RATE_LIMITED');

    // Ageing the recorded failures past the window releases it.
    await prisma.loginAttempt.updateMany({
      data: { createdAt: new Date(Date.now() - 60 * 60_000) },
    });
    const result = await login(prisma, {
      email: operator.email,
      password: operator.plainPassword,
    });
    expect(result.token).toBeTruthy();
  });

  it('counts attempts against an address that does not exist', async () => {
    // The shape credential stuffing takes. A counter on a user row could not
    // see these, because there is no row.
    for (let attempt = 0; attempt < EMAIL_ATTEMPT_LIMIT; attempt += 1) {
      await failLogin('nobody@example.test');
    }
    const state = await lockoutState(prisma, { email: 'nobody@example.test' });
    expect(state.locked).toBe(true);
    expect(state.emailFailures).toBe(EMAIL_ATTEMPT_LIMIT);
  });

  it('does not let one address lock out another', async () => {
    const victim = await makeOperator();
    const other = await makeOperator();

    for (let attempt = 0; attempt < EMAIL_ATTEMPT_LIMIT + 2; attempt += 1) {
      await failLogin(victim.email);
    }

    // The other operator signs in normally: lockout is per address, and nothing
    // was written to any user row.
    const result = await login(prisma, { email: other.email, password: other.plainPassword });
    expect(result.token).toBeTruthy();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).isActive).toBe(true);
  });

  it('clears the count for an address after a successful sign-in', async () => {
    const operator = await makeOperator();
    for (let attempt = 0; attempt < EMAIL_ATTEMPT_LIMIT - 1; attempt += 1) {
      await failLogin(operator.email);
    }
    expect((await lockoutState(prisma, { email: operator.email })).emailFailures).toBe(
      EMAIL_ATTEMPT_LIMIT - 1,
    );

    await login(prisma, { email: operator.email, password: operator.plainPassword });

    // Someone who mistypes their password and then gets it right is not one
    // mistake away from a lockout.
    const state = await lockoutState(prisma, { email: operator.email });
    expect(state.emailFailures).toBe(0);
    expect(state.locked).toBe(false);
  });

  it('throttles one client address spraying many accounts', async () => {
    const attacker = '203.0.113.9';
    for (let attempt = 0; attempt < IP_ATTEMPT_LIMIT; attempt += 1) {
      await failLogin(`victim-${attempt}@example.test`, attacker);
    }

    // No single address is anywhere near its own limit, but the client is.
    const state = await lockoutState(prisma, { email: 'fresh@example.test', clientIp: attacker });
    expect(state.emailFailures).toBe(0);
    expect(state.ipFailures).toBeGreaterThanOrEqual(IP_ATTEMPT_LIMIT);
    expect(state.locked).toBe(true);

    // A different client is unaffected.
    const elsewhere = await lockoutState(prisma, {
      email: 'fresh@example.test',
      clientIp: '198.51.100.4',
    });
    expect(elsewhere.locked).toBe(false);
  });

  it('records every attempt, including the ones it refused', async () => {
    const operator = await makeOperator();
    for (let attempt = 0; attempt < EMAIL_ATTEMPT_LIMIT + 3; attempt += 1) {
      await failLogin(operator.email, '203.0.113.1');
    }
    // A sustained attack stays visible rather than going quiet once refused.
    expect(await prisma.loginAttempt.count({ where: { succeeded: false } })).toBe(
      EMAIL_ATTEMPT_LIMIT + 3,
    );
  });

  it('prunes attempts once they are no longer evidence', async () => {
    await failLogin('old@example.test');
    await prisma.loginAttempt.updateMany({
      data: { createdAt: new Date(Date.now() - 96 * 3_600_000) },
    });
    await failLogin('recent@example.test');

    expect(await pruneLoginAttempts(prisma)).toBe(1);
    expect(await prisma.loginAttempt.count()).toBe(1);
  });
});

describe('session expiry and revocation', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('stops accepting a session once it expires, and cleans the row up', async () => {
    const operator = await makeOperator();
    const { token } = await login(prisma, {
      email: operator.email,
      password: operator.plainPassword,
    });
    expect(await resolveSession(prisma, token)).not.toBeNull();

    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await resolveSession(prisma, token)).toBeNull();
    // Resolving an expired session removes it rather than leaving it to rot.
    expect(await prisma.session.count()).toBe(0);
  });

  it('purges expired sessions in the maintenance sweep', async () => {
    const operator = await makeOperator();
    await login(prisma, { email: operator.email, password: operator.plainPassword });
    await login(prisma, { email: operator.email, password: operator.plainPassword });
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const purged = await purgeExpiredSessions(prisma);
    expect(purged.operatorSessions).toBe(2);
    expect(await prisma.session.count()).toBe(0);
  });

  it('signs one device out without touching the others', async () => {
    const operator = await makeOperator();
    const laptop = await login(prisma, {
      email: operator.email,
      password: operator.plainPassword,
    });
    const phone = await login(prisma, { email: operator.email, password: operator.plainPassword });

    await logout(prisma, laptop.token);
    expect(await resolveSession(prisma, laptop.token)).toBeNull();
    expect(await resolveSession(prisma, phone.token)).not.toBeNull();
  });

  it('revokes every session for one operator, and records why', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const operator = await makeOperator();
    const first = await login(prisma, { email: operator.email, password: operator.plainPassword });
    const second = await login(prisma, { email: operator.email, password: operator.plainPassword });

    const revoked = await revokeSessionsFor(
      prisma,
      actorFor(admin),
      operator.id,
      'Laptop left on a train',
    );
    expect(revoked).toBe(2);
    expect(await resolveSession(prisma, first.token)).toBeNull();
    expect(await resolveSession(prisma, second.token)).toBeNull();

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { action: 'operator.sessions_revoked' },
    });
    expect(event.summary).toMatch(/Laptop left on a train/);
  });

  it('rotating a password ends every live session and refuses the old one', async () => {
    // The case this answers is a credential that leaked. Changing the password
    // while leaving the cookies alive would fix nothing for whoever already has
    // one, so the two have to happen together.
    const operator = await makeOperator();
    const laptop = await login(prisma, {
      email: operator.email,
      password: operator.plainPassword,
    });
    const phone = await login(prisma, { email: operator.email, password: operator.plainPassword });

    const replacement = 'a-replacement-password-long-enough';
    const result = await rotateOperatorPassword(prisma, SYSTEM_ACTOR, {
      email: operator.email.toUpperCase(),
      newPassword: replacement,
      reason: 'Password was exposed in a transcript',
    });

    expect(result.sessionsRevoked).toBe(2);
    expect(await resolveSession(prisma, laptop.token)).toBeNull();
    expect(await resolveSession(prisma, phone.token)).toBeNull();

    await expect(
      login(prisma, { email: operator.email, password: operator.plainPassword }),
    ).rejects.toBeInstanceOf(AppError);

    const fresh = await login(prisma, { email: operator.email, password: replacement });
    expect(await resolveSession(prisma, fresh.token)).not.toBeNull();

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { action: 'operator.password_rotated' },
    });
    expect(event.summary).toMatch(/exposed in a transcript/);
  });

  it('deactivating an operator ends their sessions immediately', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const operator = await makeOperator();
    const session = await login(prisma, {
      email: operator.email,
      password: operator.plainPassword,
    });

    const result = await deactivateOperator(
      prisma,
      actorFor(admin),
      operator.id,
      'Left the company',
    );
    expect(result.sessionsRevoked).toBe(1);

    // Both the row is gone and the account check would refuse anyway.
    expect(await prisma.session.count({ where: { userId: operator.id } })).toBe(0);
    expect(await resolveSession(prisma, session.token)).toBeNull();

    const denied = await expectFailure(
      login(prisma, { email: operator.email, password: operator.plainPassword }),
    );
    expect(denied.message).toMatch(/deactivated/);
  });

  it('refuses to let an operator deactivate themselves, or to skip the reason', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const other = await makeOperator();

    await expect(deactivateOperator(prisma, actorFor(admin), admin.id, 'oops')).rejects.toThrow(
      /your own account/,
    );
    await expect(deactivateOperator(prisma, actorFor(admin), other.id, '  ')).rejects.toThrow(
      /reason is required/,
    );
  });
});
