import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { confirmAssignment } from '@/server/services/staffing';

type Params = { params: Promise<{ assignmentId: string }> };

/**
 * HUMAN OPERATOR CONFIRMATION that consumes a project seat.
 * The capacity guard lives in the staffing service, not here.
 */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'staffing:confirm');
  const { assignmentId } = await params;
  const result = await confirmAssignment(prisma, actor, assignmentId);
  return ok(result);
});
