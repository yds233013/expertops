import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  CANDIDATE_COOKIE,
  readCandidateCookie,
  readCsrfCookie,
  sessionCookieOptions,
} from '@/server/http/context';
import { assertCsrf } from '@/server/http/csrf';
import { ok, parseJson, route } from '@/server/http/respond';
import { endCandidateSession, redeemCandidateToken } from '@/server/services/candidate-portal';

const bodySchema = z.object({ token: z.string().min(10) });

/**
 * Exchange a single-use screening link for a candidate session cookie.
 *
 * The token arrives in a JSON body rather than the URL of this request, so it
 * never reaches an access log. The service burns it in the same statement that
 * claims it, so a link opened twice produces exactly one session.
 */
export const POST = route(async (request: NextRequest) => {
  assertCsrf(request, readCsrfCookie(request));
  const body = await parseJson(request, bodySchema);
  const result = await redeemCandidateToken(prisma, body.token);
  const response = ok({
    candidate: {
      id: result.candidate.id,
      fullName: result.candidate.fullName,
      reference: result.candidate.reference,
    },
    expiresAt: result.expiresAt.toISOString(),
  });
  response.cookies.set(
    CANDIDATE_COOKIE,
    result.sessionToken,
    sessionCookieOptions(result.expiresAt),
  );
  return response;
});

export const DELETE = route(async (request: NextRequest) => {
  assertCsrf(request, readCsrfCookie(request));
  await endCandidateSession(prisma, readCandidateCookie(request));
  const response = ok({ signedOut: true });
  response.cookies.set(CANDIDATE_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
});
