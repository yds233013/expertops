import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { ExpertStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { setExpertStatus } from '@/server/services/experts';

type Params = { params: Promise<{ expertId: string }> };

const bodySchema = z.object({
  status: z.enum(Object.values(ExpertStatus) as [string, ...string[]]),
  reason: z.string().max(500).optional(),
});

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'expert:write');
  const { expertId } = await params;
  const body = await parseJson(request, bodySchema);
  const expert = await setExpertStatus(prisma, actor, expertId, body.status as ExpertStatus, {
    reason: body.reason,
  });
  return ok({ expert });
});
