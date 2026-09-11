import { type NextRequest } from 'next/server';
import { type SupportStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { listSupportRequests, supportCounts } from '@/server/services/support';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'support:read');
  const params = request.nextUrl.searchParams;
  const [requests, counts] = await Promise.all([
    listSupportRequests(prisma, {
      status: (params.get('status') as SupportStatus) ?? undefined,
      expertId: params.get('expertId') ?? undefined,
      projectId: params.get('projectId') ?? undefined,
      blockingOnly: params.get('blocking') === 'true',
      overdueOnly: params.get('overdue') === 'true',
    }),
    supportCounts(prisma),
  ]);
  return ok({ requests, counts });
});
