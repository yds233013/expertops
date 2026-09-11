import { type NextRequest } from 'next/server';
import { type OutboxStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { listMessages, outboxCounts } from '@/server/services/outbox';

export const dynamic = 'force-dynamic';

/** Reads the SIMULATED outbox. No message here was delivered to a mail server. */
export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'outbox:read');
  const params = request.nextUrl.searchParams;
  const status = params.get('status');
  const [result, counts] = await Promise.all([
    listMessages(prisma, {
      status: status ? (status as OutboxStatus) : undefined,
      expertId: params.get('expertId') ?? undefined,
      projectId: params.get('projectId') ?? undefined,
      template: params.get('template') ?? undefined,
      search: params.get('search') ?? undefined,
      limit: params.get('limit') ? Number(params.get('limit')) : undefined,
      cursor: params.get('cursor') ?? undefined,
    }),
    outboxCounts(prisma),
  ]);
  return ok({ ...result, counts, simulated: true });
});
