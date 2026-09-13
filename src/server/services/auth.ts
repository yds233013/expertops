import { type User, type UserRole } from '@prisma/client';
import { type Db, type Transactor, withTransaction } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { getEnv } from '@/lib/env';
import { badRequest, conflict, notFound, unauthenticated } from '@/lib/errors';
import { generateToken, hashPassword, hashToken, verifyPassword } from '@/lib/crypto';
import { hoursFromNow } from '@/lib/time';
import { type Actor, operatorActor, recordActivity } from './activity';
import { lockoutState, recordAttempt, tooManyAttempts } from './login-protection';

export interface AuthenticatedOperator {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export function toAuthenticatedOperator(user: User): AuthenticatedOperator {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: AuthenticatedOperator;
}

/**
 * Verify credentials and mint a session.
 *
 * A wrong password and an unknown email produce the same error and both run a
 * bcrypt comparison, so response timing does not reveal which accounts exist.
 *
 * Every attempt is recorded, and a caller that has failed too often inside the
 * window is refused before the comparison runs. Without that the endpoint is an
 * unlimited password oracle: hiding *which* accounts exist does nothing about
 * an attacker working through a list against one that does.
 */
export async function login(
  db: Db,
  input: { email: string; password: string; clientIp?: string | null },
): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();
  const context = { email, clientIp: input.clientIp ?? null };

  const lockout = await lockoutState(db, context);
  if (lockout.locked) {
    // Recorded too, so a sustained attack is visible rather than invisible for
    // as long as it keeps being refused.
    await recordAttempt(db, { ...context, succeeded: false });
    throw tooManyAttempts(lockout.retryAfterSeconds);
  }

  const user = await db.user.findUnique({ where: { email } });

  const DUMMY_HASH = '$2a$04$C1SWhtEBJCNr8n3nYqZE3O8CrGfF6hPcBcP0Q5t7lJcbZ4S0ywKGa';
  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !passwordOk) {
    await recordAttempt(db, { ...context, succeeded: false });
    throw unauthenticated('Email or password is incorrect.');
  }
  if (!user.isActive) {
    await recordAttempt(db, { ...context, succeeded: false });
    throw unauthenticated('This operator account is deactivated.');
  }

  await recordAttempt(db, { ...context, succeeded: true });
  const token = generateToken();
  const expiresAt = hoursFromNow(getEnv().SESSION_TTL_HOURS);
  await db.session.create({
    data: { userId: user.id, tokenHash: hashToken(token), expiresAt },
  });

  await recordActivity(db, {
    actor: operatorActor(user),
    entityType: 'user',
    entityId: user.id,
    action: 'operator.signed_in',
    summary: `${user.name} signed in`,
  });

  return { token, expiresAt, user: toAuthenticatedOperator(user) };
}

/** Resolve a raw session token to an operator, sliding `lastSeenAt` forward. */
export async function resolveSession(
  db: Db,
  token: string | undefined | null,
): Promise<AuthenticatedOperator | null> {
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= clockNow().getTime()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (!session.user.isActive) return null;

  // Only touch the row once a minute; otherwise every page render writes.
  if (clockNow().getTime() - session.lastSeenAt.getTime() > 60_000) {
    await db.session
      .update({ where: { id: session.id }, data: { lastSeenAt: clockNow() } })
      .catch(() => undefined);
  }

  return toAuthenticatedOperator(session.user);
}

export async function logout(db: Db, token: string | undefined | null): Promise<void> {
  if (!token) return;
  await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/**
 * End every session belonging to one operator, everywhere.
 *
 * Signing out ends the session in front of you. This is the other thing: a
 * laptop left somewhere, a password changed because it was shared, an account
 * being deactivated. Sessions are server-side rows, so deleting them takes
 * effect on the next request rather than whenever a token happens to expire.
 */
export async function revokeSessionsFor(
  db: Db,
  actor: Actor,
  userId: string,
  reason: string,
): Promise<number> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('Operator not found.');
  if (!reason.trim()) throw badRequest('A reason is required to revoke sessions.');

  const removed = await db.session.deleteMany({ where: { userId } });
  if (removed.count === 0) return 0;

  await recordActivity(db, {
    actor,
    entityType: 'user',
    entityId: userId,
    action: 'operator.sessions_revoked',
    summary: `${actor.label} signed ${user.name} out of ${removed.count} session(s): ${reason.trim()}`,
    metadata: { sessions: removed.count, reason: reason.trim() },
  });
  return removed.count;
}

/**
 * Give an operator a new password and end every session they hold.
 *
 * The two halves belong together. Rotating the password without dropping the
 * sessions leaves whoever already has a cookie signed in, which is exactly the
 * case a rotation is usually responding to — a credential that went somewhere it
 * should not have. Doing it in one transaction means there is no window where
 * the old password is dead but the old session is still alive.
 */
export async function rotateOperatorPassword(
  db: Transactor,
  actor: Actor,
  input: { email: string; newPassword: string; reason: string },
): Promise<{ userId: string; sessionsRevoked: number }> {
  const email = input.email.trim().toLowerCase();
  const reason = input.reason.trim();
  if (!reason) throw badRequest('A reason is required to rotate a password.');
  if (input.newPassword.length < 8) {
    throw badRequest('Password must be at least 8 characters.');
  }

  return withTransaction(db, async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    if (!user) throw notFound('Operator not found.');

    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(input.newPassword) },
    });
    const removed = await tx.session.deleteMany({ where: { userId: user.id } });

    await recordActivity(tx, {
      actor,
      entityType: 'user',
      entityId: user.id,
      action: 'operator.password_rotated',
      summary: `${actor.label} rotated the password for ${user.name} and ended ${removed.count} session(s): ${reason}`,
      metadata: { sessions: removed.count, reason },
    });

    return { userId: user.id, sessionsRevoked: removed.count };
  });
}

/**
 * Deactivate an operator and end their sessions in one step.
 *
 * Doing only the first leaves live cookies working until `resolveSession`
 * happens to notice, which it does — but a deactivation that leaves rows behind
 * is the kind of thing that is true today and false after a refactor.
 */
export async function deactivateOperator(
  db: Db,
  actor: Actor,
  userId: string,
  reason: string,
): Promise<{ sessionsRevoked: number }> {
  if (!reason.trim()) throw badRequest('A reason is required to deactivate an operator.');
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('Operator not found.');
  if (actor.userId === userId) throw badRequest('You cannot deactivate your own account.');

  await db.user.update({ where: { id: userId }, data: { isActive: false } });
  const sessionsRevoked = await revokeSessionsFor(db, actor, userId, reason);

  await recordActivity(db, {
    actor,
    entityType: 'user',
    entityId: userId,
    action: 'operator.deactivated',
    summary: `${actor.label} deactivated ${user.name}: ${reason.trim()}`,
    metadata: { sessionsRevoked },
  });
  return { sessionsRevoked };
}

export async function purgeExpiredSessions(db: Db, now: Date = clockNow()) {
  const operators = await db.session.deleteMany({ where: { expiresAt: { lte: now } } });
  const experts = await db.expertPortalSession.deleteMany({ where: { expiresAt: { lte: now } } });
  const tokens = await db.expertPortalToken.deleteMany({
    where: { expiresAt: { lte: now }, usedAt: null },
  });
  return {
    operatorSessions: operators.count,
    expertSessions: experts.count,
    portalTokens: tokens.count,
  };
}

export interface CreateOperatorInput {
  email: string;
  name: string;
  password: string;
  role?: UserRole;
}

export async function createOperator(db: Db, input: CreateOperatorInput): Promise<User> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) throw badRequest('A valid email address is required.');
  if (input.password.length < 8) {
    throw badRequest('Password must be at least 8 characters.');
  }
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) throw conflict(`An operator with email ${email} already exists.`);

  return db.user.create({
    data: {
      email,
      name: input.name.trim(),
      passwordHash: await hashPassword(input.password),
      role: input.role ?? 'OPERATOR',
    },
  });
}
