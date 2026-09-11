import { type NextRequest } from 'next/server';
import { type OffboardingTaskStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { listOffboardingTasks, offboardingCounts } from '@/server/services/offboarding';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'offboarding:read');
  const params = request.nextUrl.searchParams;
  const [tasks, counts] = await Promise.all([
    listOffboardingTasks(prisma, {
      projectId: params.get('projectId') ?? undefined,
      expertId: params.get('expertId') ?? undefined,
      status: (params.get('status') as OffboardingTaskStatus) ?? undefined,
      overdueOnly: params.get('overdue') === 'true',
    }),
    offboardingCounts(prisma),
  ]);
  return ok({ tasks, counts });
});
