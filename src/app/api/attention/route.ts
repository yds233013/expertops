import { type NextRequest } from 'next/server';
import { type AttentionKind, type AttentionSeverity } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { attentionCounts, listAttention } from '@/server/services/attention';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'attention:read');
  const params = request.nextUrl.searchParams;

  const [items, counts] = await Promise.all([
    listAttention(prisma, {
      kind: (params.get('kind') as AttentionKind) ?? undefined,
      category: params.get('category') ?? undefined,
      severity: (params.get('severity') as AttentionSeverity) ?? undefined,
      ownerId: params.get('ownerId') ?? undefined,
      unassignedOnly: params.get('unassigned') === 'true',
      projectId: params.get('projectId') ?? undefined,
      overdueOnly: params.get('overdue') === 'true',
      includeResolved: params.get('includeResolved') === 'true',
    }),
    attentionCounts(prisma),
  ]);

  return ok({ items, counts });
});
