import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { requestTaskRecheck } from '@/server/services/task-quality';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ workItemId: string }> };

/** HUMAN ACTION. Queue a fresh check of the latest submitted task. */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'quality:write');
  const { workItemId } = await params;
  return ok(await requestTaskRecheck(prisma, actor, workItemId), 202);
});
