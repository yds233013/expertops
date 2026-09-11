import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { assignAttention, dismissAttention } from '@/server/services/attention';

type Params = { params: Promise<{ itemId: string }> };

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign'), ownerId: z.string().nullable() }),
  z.object({ action: z.literal('dismiss'), reason: z.string().min(1).max(500) }),
]);

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'attention:manage');
  const { itemId } = await params;
  const body = await parseJson(request, bodySchema);

  const item =
    body.action === 'assign'
      ? await assignAttention(prisma, actor, itemId, body.ownerId)
      : await dismissAttention(prisma, actor, itemId, body.reason);

  return ok({ item });
});
