import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { capabilitiesFor } from '@/server/auth/permissions';
import { OPERATOR_COOKIE, sessionCookieOptions } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { login } from '@/server/services/auth';

const bodySchema = z.object({
  email: z.string().min(3),
  password: z.string().min(1),
});

export const POST = route(async (request: NextRequest) => {
  const body = await parseJson(request, bodySchema);
  const result = await login(prisma, body);

  const response = ok({
    user: result.user,
    capabilities: capabilitiesFor(result.user.role),
    expiresAt: result.expiresAt.toISOString(),
  });
  response.cookies.set(OPERATOR_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
  return response;
});
