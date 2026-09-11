import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import {
  decideBatch,
  dispatchBatch,
  getBatch,
  submitBatchForApproval,
} from '@/server/services/outreach';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ batchId: string }> };

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('submit') }),
  z.object({
    action: z.literal('decide'),
    approve: z.boolean(),
    note: z.string().max(2000).optional(),
  }),
  z.object({
    action: z.literal('dispatch'),
    ttlHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional(),
    message: z.string().max(2000).optional(),
  }),
]);

export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'outreach:read');
  const { batchId } = await params;
  return ok({ batch: await getBatch(prisma, batchId) });
});

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { batchId } = await params;
  const body = await parseJson(request, bodySchema);

  if (body.action === 'submit') {
    const { actor } = await requireCapabilityFromRequest(request, 'outreach:write');
    return ok({ batch: await submitBatchForApproval(prisma, actor, batchId) });
  }

  // Approving and dispatching both need the approval capability: dispatch is
  // the moment messages are actually created.
  const { actor } = await requireCapabilityFromRequest(request, 'outreach:approve');

  if (body.action === 'decide') {
    return ok({ batch: await decideBatch(prisma, actor, { batchId, ...body }) });
  }

  const result = await dispatchBatch(prisma, actor, batchId, {
    ttlHours: body.ttlHours,
    message: body.message,
  });
  return ok({
    batch: result.batch,
    dispatched: result.dispatched,
    skipped: result.skipped,
    simulated: true,
  });
});
