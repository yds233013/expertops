import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { confirmTask } from '@/server/services/offboarding';

type Params = { params: Promise<{ taskId: string }> };

const bodySchema = z.object({
  note: z.string().min(1).max(2000),
  notApplicable: z.boolean().optional(),
});

/**
 * HUMAN CONFIRMATION. The note is required because ExpertOps has no way to
 * verify that an external account was actually removed.
 */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'offboarding:confirm');
  const { taskId } = await params;
  const body = await parseJson(request, bodySchema);
  const task = await confirmTask(prisma, actor, { taskId, ...body });
  return ok({ task, verifiedBySystem: false });
});
