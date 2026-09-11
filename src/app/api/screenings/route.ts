import { type NextRequest } from 'next/server';
import { type ScreeningStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { listScreenings } from '@/server/services/screening';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const { operator } = await requireCapabilityFromRequest(request, 'screening:read');
  const params = request.nextUrl.searchParams;
  return ok({
    screenings: await listScreenings(prisma, {
      status: (params.get('status') as ScreeningStatus) ?? undefined,
      reviewerId:
        params.get('mine') === 'true' ? operator.id : (params.get('reviewerId') ?? undefined),
      overdueOnly: params.get('overdue') === 'true',
    }),
  });
});
