import { type NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import {
  approveBatch,
  exportBatch,
  getBatch,
  submitBatchForApproval,
} from '@/server/services/payments';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ batchId: string }> };

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('submit') }),
  z.object({ action: z.literal('approve'), note: z.string().max(2000).optional() }),
  z.object({ action: z.literal('export') }),
]);

export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'payment:read');
  const { batchId } = await params;
  return ok({ batch: await getBatch(prisma, batchId) });
});

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { batchId } = await params;
  const body = await parseJson(request, bodySchema);

  if (body.action === 'submit') {
    const { actor } = await requireCapabilityFromRequest(request, 'payment:write');
    return ok({ batch: await submitBatchForApproval(prisma, actor, batchId) });
  }

  // Approval and export are the money-adjacent steps and need the stronger
  // capability. The service also refuses self-approval.
  const { actor } = await requireCapabilityFromRequest(request, 'payment:approve');

  if (body.action === 'approve') {
    return ok({ batch: await approveBatch(prisma, actor, { batchId, note: body.note }) });
  }

  const result = await exportBatch(prisma, actor, batchId);
  return new NextResponse(result.csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${result.filename}"`,
      // Restated in the response itself.
      'x-expertops-note': 'Exported for finance. Not a record of payment.',
    },
  });
});
