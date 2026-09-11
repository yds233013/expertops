import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { getWorkItem, reviewWork } from '@/server/services/work';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ workItemId: string }> };

const bodySchema = z.object({
  approve: z.boolean(),
  summary: z.string().max(4000).optional(),
  feedback: z.record(z.string(), z.string().max(2000)).optional(),
  revisionRequest: z.string().max(4000).optional(),
  approvedQuantity: z.union([z.string(), z.number()]).optional(),
});

export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'work:read');
  const { workItemId } = await params;
  return ok({ workItem: await getWorkItem(prisma, workItemId) });
});

/** HUMAN DECISION. Approving sets the quantity payment preparation will read. */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'work:review');
  const { workItemId } = await params;
  const body = await parseJson(request, bodySchema);
  const result = await reviewWork(prisma, actor, { workItemId, ...body });
  return ok({
    workItem: result.workItem,
    review: result.review,
    // Restated at the boundary so no client infers a standing judgement.
    affectsExpertRanking: false,
  });
});
