import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { type WorkItemStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { created, ok, parseJson, route } from '@/server/http/respond';
import { createWorkItem, listWorkItems, workCounts } from '@/server/services/work';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  assignmentId: z.string().min(1),
  title: z.string().min(1).max(200),
  instructions: z.string().max(8000).optional(),
  basis: z.enum(['HOURLY', 'DELIVERABLE']).optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'work:read');
  const params = request.nextUrl.searchParams;
  const [items, counts] = await Promise.all([
    listWorkItems(prisma, {
      projectId: params.get('projectId') ?? undefined,
      expertId: params.get('expertId') ?? undefined,
      status: (params.get('status') as WorkItemStatus) ?? undefined,
    }),
    workCounts(prisma),
  ]);
  return ok({ items, counts });
});

export const POST = route(async (request: NextRequest) => {
  const { actor } = await requireCapabilityFromRequest(request, 'work:write');
  const body = await parseJson(request, createSchema);
  return created({ workItem: await createWorkItem(prisma, actor, body) });
});
