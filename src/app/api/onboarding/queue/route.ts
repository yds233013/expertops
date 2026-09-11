import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { listVerificationQueue, onboardingCounts } from '@/server/services/onboarding';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'onboarding:read');
  const [queue, counts] = await Promise.all([
    listVerificationQueue(prisma),
    onboardingCounts(prisma),
  ]);
  return ok({ queue, counts });
});
