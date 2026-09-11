import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { OPERATOR_COOKIE, readSessionCookie } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { logout } from '@/server/services/auth';

export const POST = route(async (request: NextRequest) => {
  await logout(prisma, readSessionCookie(request));
  const response = ok({ signedOut: true });
  response.cookies.set(OPERATOR_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
});
