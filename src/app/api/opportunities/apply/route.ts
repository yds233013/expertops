import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { readCsrfCookie } from '@/server/http/context';
import { assertCsrf } from '@/server/http/csrf';
import { created, ok, parseJson, route } from '@/server/http/respond';
import { clientAddress } from '@/server/services/login-protection';
import { applyToOpportunity } from '@/server/services/applications';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  opportunitySlug: z.string().min(1).max(200),
  fullName: z.string().min(2).max(200),
  email: z.string().min(3).max(320),
  experience: z.string().min(1).max(5000),
  skills: z.array(z.string().max(80)).max(20).optional(),
  weeklyHours: z.number().int().nullable().optional(),
  answers: z.record(z.string(), z.string().max(4000)).optional(),
  workSampleLinks: z.array(z.string().max(500)).max(5).optional(),
});

/**
 * Submit an application.
 *
 * No session is required — the whole point is that an applicant arrives
 * without an operator having entered them first — but CSRF still applies, so a
 * third-party page cannot post applications on somebody's behalf. Everything
 * that decides whether this is allowed at all (draft, closed, past deadline,
 * duplicate, rate limit) is in the service, not here.
 */
export const POST = route(async (request: NextRequest) => {
  assertCsrf(request, readCsrfCookie(request));
  const body = await parseJson(request, bodySchema);
  const result = await applyToOpportunity(prisma, {
    ...body,
    clientIp: clientAddress(request),
  });

  const payload = {
    reference: result.application.reference,
    candidateReference: result.candidateReference,
    status: result.application.status,
    alreadyApplied: !result.created,
  };
  return result.created ? created(payload) : ok(payload);
});
