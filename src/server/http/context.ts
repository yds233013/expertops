import { cookies } from 'next/headers';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { unauthenticated } from '@/lib/errors';
import { assertCapability, type Capability } from '@/server/auth/permissions';
import { type AuthenticatedOperator, resolveSession } from '@/server/services/auth';
import { operatorActor, expertActor, type Actor } from '@/server/services/activity';
import { resolvePortalSession } from '@/server/services/portal-access';
import { type Expert } from '@prisma/client';

export const OPERATOR_COOKIE = 'expertops_session';
export const PORTAL_COOKIE = 'expertops_portal';

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

export async function requireOperatorFromRequest(request: Request): Promise<AuthenticatedOperator> {
  const operator = await operatorFromRequest(request);
  if (!operator) throw unauthenticated('Sign in to continue.');
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

export async function requireExpertFromRequest(
  request: Request,
): Promise<{ expert: Expert; actor: Actor }> {
  const expert = await expertFromRequest(request);
  if (!expert) throw unauthenticated('Open your portal link to continue.');
  return { expert, actor: expertActor(expert) };
}

export function readSessionCookie(request: Request): string | undefined {
  return readCookie(request, OPERATOR_COOKIE);
}

export function readPortalCookie(request: Request): string | undefined {
  return readCookie(request, PORTAL_COOKIE);
}
