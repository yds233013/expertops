import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { OPERATOR_COOKIE, readCsrfCookie, readSessionCookie } from '@/server/http/context';
import { assertCsrf } from '@/server/http/csrf';
import { ok, route } from '@/server/http/respond';
import { logout } from '@/server/services/auth';

export const POST = route(async (request: NextRequest) => {
  assertCsrf(request, readCsrfCookie(request));
  await logout(prisma, readSessionCookie(request));
  const response = ok({ signedOut: true });
  response.cookies.set(OPERATOR_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
});
