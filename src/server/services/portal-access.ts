import { type Expert, type PortalTokenPurpose } from '@prisma/client';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { getEnv, portalLinksVisible } from '@/lib/env';
import { unauthenticated } from '@/lib/errors';
import { generateToken, hashToken } from '@/lib/crypto';
import { hoursFromNow } from '@/lib/time';

/**
 * Expert portal access.
 *
 * Experts never get a password. They receive a single-use magic link in a
 * simulated email; exchanging it mints a short-lived portal session cookie.
 */
export interface IssuedPortalToken {
  token: string;
  url: string;
  expiresAt: Date;
}

export async function issuePortalToken(
  db: Db,
  input: { expertId: string; purpose?: PortalTokenPurpose; ttlHours?: number },
): Promise<IssuedPortalToken> {
  const env = getEnv();
  const token = generateToken();
  const expiresAt = hoursFromNow(input.ttlHours ?? env.PORTAL_TOKEN_TTL_HOURS);
  const url = buildPortalUrl(token);

  await db.expertPortalToken.create({
    data: {
      expertId: input.expertId,
      tokenHash: hashToken(token),
      purpose: input.purpose ?? 'GENERAL',
      expiresAt,
      // Development-only: lets the operator outbox display a working link so the
      // full workflow is demoable without a mail server. Guarded by NODE_ENV.
      devPlaintext: portalLinksVisible() ? token : null,
    },
  });

  return { token, url, expiresAt };
}

export function buildPortalUrl(token: string): string {
  return `${getEnv().APP_BASE_URL.replace(/\/$/, '')}/portal/enter/${token}`;
}

export interface PortalSessionResult {
  sessionToken: string;
  expiresAt: Date;
  expert: Expert;
}

/**
 * Exchange a magic-link token for a portal session.
 *
 * The token is marked used in the same transaction, so a link forwarded to a
 * second person cannot open a second session.
 */
export async function redeemPortalToken(db: Db, rawToken: string): Promise<PortalSessionResult> {
  const tokenHash = hashToken(rawToken);
  const record = await db.expertPortalToken.findUnique({
    where: { tokenHash },
    include: { expert: true },
  });

  if (!record) throw unauthenticated('This portal link is not valid.');
  if (record.revokedAt) throw unauthenticated('This portal link has been revoked.');
  if (record.usedAt) throw unauthenticated('This portal link has already been used.');
  if (record.expiresAt.getTime() <= clockNow().getTime()) {
    throw unauthenticated(
      'This portal link has expired. Ask your ExpertOps contact for a new one.',
    );
  }
  if (record.expert.status === 'ARCHIVED') {
    throw unauthenticated('This expert profile is no longer active.');
  }

  const claimed = await db.expertPortalToken.updateMany({
    where: { id: record.id, usedAt: null, revokedAt: null },
    data: { usedAt: clockNow() },
  });
  if (claimed.count === 0) {
    // Another request redeemed the same link first.
    throw unauthenticated('This portal link has already been used.');
  }

  const sessionToken = generateToken();
  const expiresAt = hoursFromNow(getEnv().SESSION_TTL_HOURS);
  await db.expertPortalSession.create({
    data: { expertId: record.expertId, tokenHash: hashToken(sessionToken), expiresAt },
  });

  return { sessionToken, expiresAt, expert: record.expert };
}

export async function resolvePortalSession(
  db: Db,
  token: string | undefined | null,
): Promise<Expert | null> {
  if (!token) return null;
  const session = await db.expertPortalSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { expert: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= clockNow().getTime()) {
    await db.expertPortalSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (session.expert.status === 'ARCHIVED') return null;

  if (clockNow().getTime() - session.lastSeenAt.getTime() > 60_000) {
    await db.expertPortalSession
      .update({ where: { id: session.id }, data: { lastSeenAt: clockNow() } })
      .catch(() => undefined);
  }
  return session.expert;
}

export async function endPortalSession(db: Db, token: string | undefined | null): Promise<void> {
  if (!token) return;
  await db.expertPortalSession.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function revokePortalTokens(db: Db, expertId: string): Promise<number> {
  const result = await db.expertPortalToken.updateMany({
    where: { expertId, usedAt: null, revokedAt: null },
    data: { revokedAt: clockNow() },
  });
  return result.count;
}
