import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import {
  getCandidate,
  optOutCandidate,
  submitApplication,
  updateRelationship,
} from '@/server/services/candidates';
import { startScreening } from '@/server/services/screening';
import { markScreeningStartedForCandidate } from '@/server/services/applications';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ candidateId: string }> };

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('update_relationship'),
    relationshipOwnerId: z.string().nullable().optional(),
    notes: z.string().max(4000).optional(),
    nextActionAt: z.coerce.date().nullable().optional(),
    nextActionNote: z.string().max(500).optional(),
  }),
  z.object({ action: z.literal('opt_out'), reason: z.string().max(500) }),
  z.object({
    action: z.literal('submit_application'),
    domainId: z.string().min(1),
    answers: z.record(z.string(), z.unknown()).optional(),
    workSampleLinks: z.array(z.string().max(500)).max(10).optional(),
  }),
  z.object({
    action: z.literal('start_screening'),
    rubricVersionId: z.string().min(1),
    dueInHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .optional(),
  }),
]);

export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'candidate:read');
  const { candidateId } = await params;
  return ok({ candidate: await getCandidate(prisma, candidateId) });
});

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { candidateId } = await params;
  const body = await parseJson(request, bodySchema);

  if (body.action === 'start_screening') {
    const { actor } = await requireCapabilityFromRequest(request, 'screening:write');
    const screening = await startScreening(prisma, actor, {
      candidateId,
      rubricVersionId: body.rubricVersionId,
      dueInHours: body.dueInHours,
    });
    // Any application this person made is now in screening, so its status says
    // so rather than staying on "submitted" while a screening runs.
    await markScreeningStartedForCandidate(prisma, candidateId);
    return ok({ screening });
  }

  const { actor } = await requireCapabilityFromRequest(request, 'candidate:write');

  if (body.action === 'update_relationship') {
    return ok({ candidate: await updateRelationship(prisma, actor, candidateId, body) });
  }
  if (body.action === 'opt_out') {
    return ok({ candidate: await optOutCandidate(prisma, actor, candidateId, body.reason) });
  }

  const application = await submitApplication(prisma, actor, {
    candidateId,
    domainId: body.domainId,
    answers: body.answers,
    workSampleLinks: body.workSampleLinks,
  });
  return ok({ application });
});
