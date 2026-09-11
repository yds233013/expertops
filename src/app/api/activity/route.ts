import { type NextRequest } from 'next/server';
import { type ActorType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { listActivity } from '@/server/services/activity';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'activity:read');
  const params = request.nextUrl.searchParams;
  const actorType = params.get('actorType');
  const result = await listActivity(prisma, {
    projectId: params.get('projectId') ?? undefined,
    expertId: params.get('expertId') ?? undefined,
    entityType: params.get('entityType') ?? undefined,
    entityId: params.get('entityId') ?? undefined,
    actorType: actorType ? (actorType as ActorType) : undefined,
    limit: params.get('limit') ? Number(params.get('limit')) : undefined,
    cursor: params.get('cursor') ?? undefined,
  });
  return ok(result);
});
