import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCandidateFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { candidateActor } from '@/server/services/activity';
import { getScreeningForCandidate, submitScreening } from '@/server/services/screening';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ screeningId: string }> };

const bodySchema = z.object({
  answers: z.record(z.string().min(1).max(64), z.string().max(8000)),
  workSampleLinks: z.array(z.string().max(500)).max(10).optional(),
  note: z.string().max(2000).optional(),
});

/**
 * The candidate's own screening.
 *
 * Authorisation is by session, never by the id in the URL: the service refuses
 * any screening that does not belong to the session's candidate, so changing
 * the id in the address bar returns "not found" rather than someone else's
 * application.
 */
export const GET = route(async (request: NextRequest, { params }: Params) => {
  const candidate = await requireCandidateFromRequest(request);
  const { screeningId } = await params;
  return ok({ screening: await getScreeningForCandidate(prisma, screeningId, candidate.id) });
});

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const candidate = await requireCandidateFromRequest(request);
  const { screeningId } = await params;
  const body = await parseJson(request, bodySchema);

  // Ownership is checked before the submission is accepted, using the same
  // projection the read path uses.
  await getScreeningForCandidate(prisma, screeningId, candidate.id);

  const result = await submitScreening(prisma, candidateActor(candidate), {
    screeningId,
    answers: body.answers,
    workSampleLinks: body.workSampleLinks,
    note: body.note,
  });

  return ok({
    revision: result.revision,
    isComplete: result.isComplete,
    missingEvidence: result.missingEvidence,
    status: result.screening.status,
  });
});
