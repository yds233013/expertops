import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { releaseAssignment } from '@/server/services/staffing';

type Params = { params: Promise<{ assignmentId: string }> };

const bodySchema = z.object({ reason: z.string().min(1).max(500) });

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'staffing:release');
  const { assignmentId } = await params;
  const body = await parseJson(request, bodySchema);
  return ok(await releaseAssignment(prisma, actor, assignmentId, body.reason));
});
