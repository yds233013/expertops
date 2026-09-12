import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { capabilitiesFor } from '@/server/auth/permissions';
import { OPERATOR_COOKIE, readCsrfCookie, sessionCookieOptions } from '@/server/http/context';
import { assertCsrf } from '@/server/http/csrf';
import { ok, parseJson, route } from '@/server/http/respond';
import { login } from '@/server/services/auth';
import { clientAddress } from '@/server/services/login-protection';

const bodySchema = z.object({
  email: z.string().min(3),
  password: z.string().min(1),
});

export const POST = route(async (request: NextRequest) => {
  // Login creates a session, so it is a state-changing request and gets the
  // same origin + token check as any authenticated mutation. The token cookie
  // is issued by middleware on the first page load.
  assertCsrf(request, readCsrfCookie(request));
  const body = await parseJson(request, bodySchema);
  const result = await login(prisma, { ...body, clientIp: clientAddress(request) });

  const response = ok({
    user: result.user,
    capabilities: capabilitiesFor(result.user.role),
    expiresAt: result.expiresAt.toISOString(),
  });
  response.cookies.set(OPERATOR_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
  return response;
});
