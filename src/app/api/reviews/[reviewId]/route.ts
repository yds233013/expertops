import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { submitReview } from '@/server/services/screening';

type Params = { params: Promise<{ reviewId: string }> };

const bodySchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'REQUEST_REVISION']),
  scores: z.record(z.string(), z.number().int().min(0).max(10)).optional(),
  publicFeedback: z.string().max(4000).optional(),
  privateNotes: z.string().max(4000).optional(),
});

/**
 * HUMAN DECISION. Only the assigned reviewer may submit, enforced in the
 * service. Private notes never leave the operator side.
 */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'screening:review');
  const { reviewId } = await params;
  const body = await parseJson(request, bodySchema);
  const result = await submitReview(prisma, actor, { reviewId, ...body });
  return ok({
    conflict: result.conflict,
    reviewCount: result.reviews.length,
    conflictRaised: result.conflict !== null && result.conflict.status === 'OPEN',
  });
});
