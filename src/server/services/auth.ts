import { type User, type UserRole } from '@prisma/client';
import { type Db } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { badRequest, conflict, unauthenticated } from '@/lib/errors';
import { generateToken, hashPassword, hashToken, verifyPassword } from '@/lib/crypto';
import { hoursFromNow } from '@/lib/time';
import { operatorActor, recordActivity } from './activity';

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
 */
export async function login(
  db: Db,
  input: { email: string; password: string },
): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();
  const user = await db.user.findUnique({ where: { email } });

  const DUMMY_HASH = '$2a$04$C1SWhtEBJCNr8n3nYqZE3O8CrGfF6hPcBcP0Q5t7lJcbZ4S0ywKGa';
  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !passwordOk) {
    throw unauthenticated('Email or password is incorrect.');
  }
  if (!user.isActive) {
    throw unauthenticated('This operator account is deactivated.');
  }

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
  if (session.expiresAt.getTime() <= Date.now()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (!session.user.isActive) return null;

  // Only touch the row once a minute; otherwise every page render writes.
  if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
    await db.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  return toAuthenticatedOperator(session.user);
}

export async function logout(db: Db, token: string | undefined | null): Promise<void> {
  if (!token) return;
  await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function purgeExpiredSessions(db: Db, now: Date = new Date()) {
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
