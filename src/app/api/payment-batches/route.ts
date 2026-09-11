import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { type PaymentBatchStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { created, ok, parseJson, route } from '@/server/http/respond';
import { createBatch, listBatches } from '@/server/services/payments';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  currency: z.string().length(3).optional(),
  note: z.string().max(2000).optional(),
  itemIds: z.array(z.string().min(1)).min(1).max(500),
});

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'payment:read');
  const status = request.nextUrl.searchParams.get('status');
  return ok({
    batches: await listBatches(prisma, { status: (status as PaymentBatchStatus) ?? undefined }),
  });
});

export const POST = route(async (request: NextRequest) => {
  const { actor } = await requireCapabilityFromRequest(request, 'payment:write');
  const body = await parseJson(request, createSchema);
  return created({ batch: await createBatch(prisma, actor, body) });
});
