import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import {
  assignSupport,
  getSupportRequest,
  replyToSupport,
  resolveSupport,
  setBlocking,
} from '@/server/services/support';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ requestId: string }> };

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('reply'),
    body: z.string().min(1).max(8000),
    internalOnly: z.boolean().optional(),
  }),
  z.object({ action: z.literal('assign'), ownerId: z.string().nullable() }),
  z.object({
    action: z.literal('set_blocking'),
    blocksReadiness: z.boolean().optional(),
    blocksDelivery: z.boolean().optional(),
    note: z.string().max(1000).optional(),
  }),
  z.object({
    action: z.literal('resolve'),
    resolution: z.string().min(1).max(4000),
    close: z.boolean().optional(),
  }),
]);

export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'support:read');
  const { requestId } = await params;
  return ok({ request: await getSupportRequest(prisma, requestId) });
});

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'support:respond');
  const { requestId } = await params;
  const body = await parseJson(request, bodySchema);

  if (body.action === 'reply') {
    return ok({
      reply: await replyToSupport(prisma, actor, {
        requestId,
        body: body.body,
        internalOnly: body.internalOnly,
      }),
    });
  }
  if (body.action === 'assign') {
    return ok({ request: await assignSupport(prisma, actor, requestId, body.ownerId) });
  }
  if (body.action === 'set_blocking') {
    return ok({ request: await setBlocking(prisma, actor, { requestId, ...body }) });
  }
  return ok({ request: await resolveSupport(prisma, actor, { requestId, ...body }) });
});
