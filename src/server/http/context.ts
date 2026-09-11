import { cookies } from 'next/headers';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { unauthenticated } from '@/lib/errors';
import { assertCapability, type Capability } from '@/server/auth/permissions';
import { assertCsrf, CSRF_COOKIE } from './csrf';
import { type AuthenticatedOperator, resolveSession } from '@/server/services/auth';
import { operatorActor, expertActor, type Actor } from '@/server/services/activity';
import { resolvePortalSession } from '@/server/services/portal-access';
import { resolveCandidateSession } from '@/server/services/candidate-portal';
import { type Candidate, type Expert } from '@prisma/client';

export const OPERATOR_COOKIE = 'expertops_session';
export const PORTAL_COOKIE = 'expertops_portal';
/**
 * Candidates get their own cookie name.
 *
 * A candidate session must never be readable as an expert session: the two
 * audiences see different data, and a candidate who is later converted into an
 * expert must not carry old access across with them.
 */
export const CANDIDATE_COOKIE = 'expertops_candidate';

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: getEnv().NODE_ENV === 'production',
    expires: expiresAt,
  };
}

/** Current operator, or null when signed out. Safe to call from any server component. */
export async function currentOperator(): Promise<AuthenticatedOperator | null> {
  const store = await cookies();
  return resolveSession(prisma, store.get(OPERATOR_COOKIE)?.value);
}

export async function requireOperator(): Promise<AuthenticatedOperator> {
  const operator = await currentOperator();
  if (!operator) throw unauthenticated('Sign in to continue.');
  return operator;
}

/**
 * Require a signed-in operator that holds `capability`.
 *
 * Returns the operator plus a ready-made activity actor, so callers never build
 * an actor by hand and history stays consistent.
 */
export async function requireCapability(
  capability: Capability,
): Promise<{ operator: AuthenticatedOperator; actor: Actor }> {
  const operator = await requireOperator();
  assertCapability(operator, capability);
  return { operator, actor: operatorActor(operator) };
}

export async function currentCandidate(): Promise<Candidate | null> {
  const store = await cookies();
  return resolveCandidateSession(prisma, store.get(CANDIDATE_COOKIE)?.value);
}

export async function requireCandidate(): Promise<Candidate> {
  const candidate = await currentCandidate();
  if (!candidate) throw unauthenticated('Open your screening link to continue.');
  return candidate;
}

export async function currentExpert(): Promise<Expert | null> {
  const store = await cookies();
  return resolvePortalSession(prisma, store.get(PORTAL_COOKIE)?.value);
}

export async function requireExpert(): Promise<{ expert: Expert; actor: Actor }> {
  const expert = await currentExpert();
  if (!expert) throw unauthenticated('Open your portal link to continue.');
  return { expert, actor: expertActor(expert) };
}

/**
 * Request-scoped variants.
 *
 * Server components use the `cookies()` helpers above; route handlers use these
 * so they can be unit-tested by constructing a NextRequest directly, with no
 * async-storage shim.
 */
function readCookie(request: Request, name: string): string | undefined {
  const maybeNext = request as Request & {
    cookies?: { get(n: string): { value: string } | undefined };
  };
  const fromNext = maybeNext.cookies?.get(name)?.value;
  if (fromNext) return fromNext;

  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export async function operatorFromRequest(request: Request): Promise<AuthenticatedOperator | null> {
  return resolveSession(prisma, readCookie(request, OPERATOR_COOKIE));
}

/**
 * Resolve the operator for a request, rejecting cross-site mutations.
 *
 * The CSRF check runs here rather than in each route handler, so a new
 * endpoint is protected by virtue of requiring a session at all. Safe methods
 * pass through untouched.
 */
export async function requireOperatorFromRequest(request: Request): Promise<AuthenticatedOperator> {
  const operator = await operatorFromRequest(request);
  if (!operator) throw unauthenticated('Sign in to continue.');
  assertCsrf(request, readCookie(request, CSRF_COOKIE));
  return operator;
}

export async function requireCapabilityFromRequest(
  request: Request,
  capability: Capability,
): Promise<{ operator: AuthenticatedOperator; actor: Actor }> {
  const operator = await requireOperatorFromRequest(request);
  assertCapability(operator, capability);
  return { operator, actor: operatorActor(operator) };
}

export async function expertFromRequest(request: Request): Promise<Expert | null> {
  return resolvePortalSession(prisma, readCookie(request, PORTAL_COOKIE));
}

/** The expert-portal equivalent. Portal sessions are cookies too, so they need
 * exactly the same protection as operator sessions. */
export async function requireExpertFromRequest(
  request: Request,
): Promise<{ expert: Expert; actor: Actor }> {
  const expert = await expertFromRequest(request);
  if (!expert) throw unauthenticated('Open your portal link to continue.');
  assertCsrf(request, readCookie(request, CSRF_COOKIE));
  return { expert, actor: expertActor(expert) };
}

export async function candidateFromRequest(request: Request): Promise<Candidate | null> {
  return resolveCandidateSession(prisma, readCookie(request, CANDIDATE_COOKIE));
}

/**
 * Resolve the candidate for a request.
 *
 * There is no actor here on purpose: a candidate is not an operator and does
 * not get an activity actor with a user id. Callers build a CANDIDATE actor
 * from the returned record.
 */
export async function requireCandidateFromRequest(request: Request): Promise<Candidate> {
  const candidate = await candidateFromRequest(request);
  if (!candidate) throw unauthenticated('Open your screening link to continue.');
  assertCsrf(request, readCookie(request, CSRF_COOKIE));
  return candidate;
}

export function readSessionCookie(request: Request): string | undefined {
  return readCookie(request, OPERATOR_COOKIE);
}

export function readPortalCookie(request: Request): string | undefined {
  return readCookie(request, PORTAL_COOKIE);
}

export function readCandidateCookie(request: Request): string | undefined {
  return readCookie(request, CANDIDATE_COOKIE);
}

export function readCsrfCookie(request: Request): string | undefined {
  return readCookie(request, CSRF_COOKIE);
}
