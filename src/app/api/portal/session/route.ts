import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { PORTAL_COOKIE, readPortalCookie, sessionCookieOptions } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { endPortalSession, redeemPortalToken } from '@/server/services/portal-access';

const bodySchema = z.object({ token: z.string().min(10) });

/** Exchange a single-use magic-link token for a portal session cookie. */
export const POST = route(async (request: NextRequest) => {
  const body = await parseJson(request, bodySchema);
  const result = await redeemPortalToken(prisma, body.token);
  const response = ok({
    expert: {
      id: result.expert.id,
      fullName: result.expert.fullName,
      email: result.expert.email,
      status: result.expert.status,
    },
    expiresAt: result.expiresAt.toISOString(),
  });
  response.cookies.set(PORTAL_COOKIE, result.sessionToken, sessionCookieOptions(result.expiresAt));
  return response;
});

export const DELETE = route(async (request: NextRequest) => {
  await endPortalSession(prisma, readPortalCookie(request));
  const response = ok({ signedOut: true });
  response.cookies.set(PORTAL_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
});
