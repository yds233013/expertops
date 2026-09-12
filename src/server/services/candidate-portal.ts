import { type Candidate } from '@prisma/client';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { getEnv, portalLinksVisible } from '@/lib/env';
import { unauthenticated } from '@/lib/errors';
import { generateToken, hashToken } from '@/lib/crypto';
import { hoursFromNow } from '@/lib/time';

/**
 * Candidate portal access.
 *
 * Mirrors the expert portal exactly: single-use magic link, no password, and a
 * short-lived session cookie. Kept as a separate table and separate cookie so a
 * candidate session can never be mistaken for an expert session, and so a
 * candidate who is later converted into an expert does not carry old access
 * across with them.
 */
export interface IssuedCandidateToken {
  token: string;
  url: string;
  expiresAt: Date;
}

/**
 * The candidate equivalent of `buildPortalUrl`, and for the same reason: the
 * token travels in the fragment so it never reaches a request log.
 */
export function buildCandidatePortalUrl(token: string): string {
  return `${getEnv().APP_BASE_URL.replace(/\/$/, '')}/apply/enter#t=${encodeURIComponent(token)}`;
}

export async function issueCandidatePortalToken(
  db: Db,
  input: { candidateId: string; ttlHours?: number },
): Promise<IssuedCandidateToken> {
  const env = getEnv();
  const token = generateToken();
  const expiresAt = hoursFromNow(input.ttlHours ?? env.PORTAL_TOKEN_TTL_HOURS, clockNow());

  await db.candidatePortalToken.create({
    data: {
      candidateId: input.candidateId,
      tokenHash: hashToken(token),
      purpose: 'SCREENING',
      expiresAt,
      devPlaintext: portalLinksVisible() ? token : null,
    },
  });

  return { token, url: buildCandidatePortalUrl(token), expiresAt };
}

export interface CandidateSessionResult {
  sessionToken: string;
  expiresAt: Date;
  candidate: Candidate;
}

export async function redeemCandidateToken(
  db: Db,
  rawToken: string,
): Promise<CandidateSessionResult> {
  const record = await db.candidatePortalToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { candidate: true },
  });

  if (!record) throw unauthenticated('This link is not valid.');
  if (record.revokedAt) throw unauthenticated('This link has been revoked.');
  if (record.usedAt) throw unauthenticated('This link has already been used.');
  if (record.expiresAt.getTime() <= clockNow().getTime()) {
    throw unauthenticated('This link has expired. Ask your contact for a new one.');
  }
  if (record.candidate.contactOptOutAt) {
    throw unauthenticated('This application is closed.');
  }
  if (['WITHDRAWN', 'REJECTED'].includes(record.candidate.stage)) {
    throw unauthenticated('This application is closed.');
  }

  // Burn the token in the same statement that claims it, so a link opened twice
  // at once produces exactly one session.
  const claimed = await db.candidatePortalToken.updateMany({
    where: { id: record.id, usedAt: null, revokedAt: null },
    data: { usedAt: clockNow() },
  });
  if (claimed.count === 0) throw unauthenticated('This link has already been used.');

  const sessionToken = generateToken();
  const expiresAt = hoursFromNow(getEnv().SESSION_TTL_HOURS, clockNow());
  await db.candidatePortalSession.create({
    data: { candidateId: record.candidateId, tokenHash: hashToken(sessionToken), expiresAt },
  });

  return { sessionToken, expiresAt, candidate: record.candidate };
}

export async function resolveCandidateSession(
  db: Db,
  token: string | undefined | null,
): Promise<Candidate | null> {
  if (!token) return null;
  const session = await db.candidatePortalSession.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= clockNow().getTime()) {
    await db.candidatePortalSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  const candidate = await db.candidate.findUnique({ where: { id: session.candidateId } });
  if (!candidate) return null;
  if (candidate.contactOptOutAt) return null;

  if (clockNow().getTime() - session.lastSeenAt.getTime() > 60_000) {
    await db.candidatePortalSession
      .update({ where: { id: session.id }, data: { lastSeenAt: clockNow() } })
      .catch(() => undefined);
  }
  return candidate;
}

export async function endCandidateSession(db: Db, token: string | undefined | null): Promise<void> {
  if (!token) return;
  await db.candidatePortalSession.deleteMany({ where: { tokenHash: hashToken(token) } });
}
