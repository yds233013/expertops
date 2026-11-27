import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { checkForScreening, requestScreeningRecheck } from '@/server/services/screening-checks';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ screeningId: string }> };

/**
 * The automated check on the latest submission. Suggested scores are withheld
 * from a reviewer who has not submitted their own review yet.
 */
export const GET = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'screening:read');
  const { screeningId } = await params;
  return ok({ check: await checkForScreening(prisma, screeningId, actor.userId ?? null) });
});

/** HUMAN ACTION. Check the latest submission again. */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'screening:write');
  const { screeningId } = await params;
  return ok(await requestScreeningRecheck(prisma, actor, screeningId), 202);
});
