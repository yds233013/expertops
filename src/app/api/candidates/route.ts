import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { type CandidateStage } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { created, ok, parseJson, route } from '@/server/http/respond';
import {
  candidateCountsByStage,
  createCandidate,
  listCandidates,
} from '@/server/services/candidates';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  fullName: z.string().min(1).max(160),
  email: z.string().email(),
  headline: z.string().max(200).optional(),
  timezone: z.string().max(64).optional(),
  yearsExperience: z.number().int().min(0).max(60).optional(),
  sourceChannelId: z.string().nullable().optional(),
  referredByExpertId: z.string().nullable().optional(),
  campaignId: z.string().nullable().optional(),
  relationshipOwnerId: z.string().nullable().optional(),
  notes: z.string().max(4000).optional(),
  nextActionAt: z.coerce.date().nullable().optional(),
  nextActionNote: z.string().max(500).optional(),
});

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'candidate:read');
  const params = request.nextUrl.searchParams;
  const [candidates, counts] = await Promise.all([
    listCandidates(prisma, {
      stage: (params.get('stage') as CandidateStage) ?? undefined,
      search: params.get('search') ?? undefined,
      campaignId: params.get('campaignId') ?? undefined,
      relationshipOwnerId: params.get('ownerId') ?? undefined,
      dueOnly: params.get('due') === 'true',
    }),
    candidateCountsByStage(prisma),
  ]);
  return ok({ candidates, counts });
});

export const POST = route(async (request: NextRequest) => {
  const { actor } = await requireCapabilityFromRequest(request, 'candidate:write');
  const body = await parseJson(request, createSchema);
  const result = await createCandidate(prisma, actor, body);
  return created({
    candidate: result.candidate,
    duplicateFlags: result.duplicateFlags,
    // Said plainly so a client cannot mistake a hold for a rejection.
    onHoldForDuplicateReview: result.duplicateFlags.length > 0,
  });
});
