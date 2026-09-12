import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireExpertFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { recordWithdrawal } from '@/server/services/staffing-gaps';

export const dynamic = 'force-dynamic';

/**
 * An expert withdraws themselves from one project.
 *
 * The expert id is never accepted from the request: it comes from the portal
 * session, so a caller can only ever withdraw themselves. The project id is
 * checked against that expert's own commitments inside the service, which is
 * what stops a valid session being used against somebody else's project.
 */
const bodySchema = z.object({
  projectId: z.string().min(1).max(64),
  reason: z.string().max(500).optional(),
});

export const POST = route(async (request: NextRequest) => {
  // Also asserts the CSRF token; a portal session alone is not enough.
  const { expert, actor } = await requireExpertFromRequest(request);
  const body = await parseJson(request, bodySchema);

  const result = await recordWithdrawal(prisma, actor, {
    projectId: body.projectId,
    expertId: expert.id,
    reason: body.reason,
  });

  return ok({
    withdrawal: {
      projectId: body.projectId,
      alreadyWithdrawn: result.alreadyWithdrawn,
      releasedAssignmentId: result.releasedAssignmentId,
      cancelledWorkItems: result.cancelledWorkItemIds.length,
    },
  });
});
