import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import {
  answerGoldTask,
  answerGoldTaskSchema,
  retireGoldTask,
} from '@/server/services/task-quality';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ goldTaskId: string }> };

const bodySchema = z.discriminatedUnion('action', [
  answerGoldTaskSchema.extend({ action: z.literal('answer') }),
  z.object({ action: z.literal('retire') }),
]);

/**
 * `answer`: HUMAN ACTION, write-once. The expected decision and rationale come
 * back only in this response.
 * `retire`: HUMAN ACTION. Takes the task out of circulation.
 */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'quality:calibrate');
  const { goldTaskId } = await params;
  const body = await parseJson(request, bodySchema);
  if (body.action === 'retire') {
    await requireCapabilityFromRequest(request, 'quality:write');
    return ok({ goldTask: await retireGoldTask(prisma, actor, goldTaskId) });
  }
  return ok(
    await answerGoldTask(prisma, actor, { goldTaskId, decision: body.decision, note: body.note }),
  );
});
