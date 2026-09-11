import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireExpertFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { submitWork } from '@/server/services/work';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ workItemId: string }> };

const bodySchema = z.object({
  summary: z.string().max(4000).optional(),
  content: z.string().min(1).max(20000),
  attachments: z.array(z.string().max(500)).max(10).optional(),
  hoursClaimed: z.union([z.string(), z.number()]).optional(),
});

/**
 * The expert submits or resubmits a work item.
 *
 * `submitWork` re-checks the expert against the item for an EXPERT actor, so a
 * changed id in the URL returns "not found" rather than another expert's work.
 */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireExpertFromRequest(request);
  const { workItemId } = await params;
  const body = await parseJson(request, bodySchema);
  const result = await submitWork(prisma, actor, { workItemId, ...body });
  return ok({ revision: result.revision, status: result.workItem.status });
});
