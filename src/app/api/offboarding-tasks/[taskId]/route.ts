import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { assignOffboardingTask, confirmTask } from '@/server/services/offboarding';

type Params = { params: Promise<{ taskId: string }> };

const bodySchema = z.union([
  z.object({
    action: z.literal('assign'),
    ownerId: z.string().min(1).nullable(),
  }),
  z.object({
    action: z.literal('confirm').optional(),
    note: z.string().min(1).max(2000),
    notApplicable: z.boolean().optional(),
  }),
]);

/**
 * Confirming needs the confirmation capability, because it is a statement of
 * fact the system cannot verify. Assigning an owner is bookkeeping about who is
 * responsible, so it needs the weaker write capability.
 */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { taskId } = await params;
  const body = await parseJson(request, bodySchema);

  if ('action' in body && body.action === 'assign') {
    const { actor } = await requireCapabilityFromRequest(request, 'offboarding:assign');
    return ok({
      task: await assignOffboardingTask(prisma, actor, { taskId, ownerId: body.ownerId }),
    });
  }

  const { actor } = await requireCapabilityFromRequest(request, 'offboarding:confirm');
  const task = await confirmTask(prisma, actor, {
    taskId,
    note: body.note,
    notApplicable: body.notApplicable,
  });
  return ok({ task, verifiedBySystem: false });
});
