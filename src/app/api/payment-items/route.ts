import { type NextRequest } from 'next/server';
import { type PaymentItemStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { listPaymentItems, paymentCounts } from '@/server/services/payments';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'payment:read');
  const params = request.nextUrl.searchParams;
  const [items, counts] = await Promise.all([
    listPaymentItems(prisma, {
      status: (params.get('status') as PaymentItemStatus) ?? undefined,
      expertId: params.get('expertId') ?? undefined,
      projectId: params.get('projectId') ?? undefined,
      batchId: params.get('batchId') ?? undefined,
    }),
    paymentCounts(prisma),
  ]);
  return ok({
    items,
    counts,
    // Repeated at every payment boundary on purpose.
    note: 'Exported means a file was produced for finance. It does not mean anyone has been paid.',
  });
});
