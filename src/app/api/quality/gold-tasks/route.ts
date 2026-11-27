import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { created, ok, parseJson, route } from '@/server/http/respond';
import {
  createGoldTask,
  createGoldTaskSchema,
  listGoldTasks,
} from '@/server/services/task-quality';

export const dynamic = 'force-dynamic';

/**
 * Gold tasks with their expected decisions. Operator-only: the key is
 * withheld from the endpoint a reviewer answers through.
 */
export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'quality:write');
  return ok({ goldTasks: await listGoldTasks(prisma) });
});

export const POST = route(async (request: NextRequest) => {
  const { actor } = await requireCapabilityFromRequest(request, 'quality:write');
  const body = await parseJson(request, createGoldTaskSchema);
  return created({ goldTask: await createGoldTask(prisma, actor, body) });
});
