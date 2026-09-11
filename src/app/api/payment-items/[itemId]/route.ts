import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { correctPaymentItem, resolveDiscrepancy } from '@/server/services/payments';

type Params = { params: Promise<{ itemId: string }> };

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('resolve_discrepancy'), resolution: z.string().min(1).max(2000) }),
  z.object({
    action: z.literal('correct'),
    quantity: z.union([z.string(), z.number()]),
    reason: z.string().min(1).max(2000),
  }),
]);

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'payment:write');
  const { itemId } = await params;
  const body = await parseJson(request, bodySchema);

  if (body.action === 'resolve_discrepancy') {
    return ok({
      item: await resolveDiscrepancy(prisma, actor, {
        paymentItemId: itemId,
        resolution: body.resolution,
      }),
    });
  }

  const result = await correctPaymentItem(prisma, actor, {
    paymentItemId: itemId,
    quantity: body.quantity,
    reason: body.reason,
  });
  return ok({
    voided: result.voided,
    replacement: result.replacement,
    invalidatedBatchId: result.invalidatedBatchId,
  });
});
