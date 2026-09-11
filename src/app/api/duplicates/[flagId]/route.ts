import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { resolveDuplicate } from '@/server/services/candidates';

type Params = { params: Promise<{ flagId: string }> };

const bodySchema = z.object({
  samePerson: z.boolean(),
  note: z.string().min(1).max(1000),
});

/**
 * HUMAN DECISION. Nothing merges two people automatically, so this endpoint is
 * the only way a duplicate flag is ever resolved.
 */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'candidate:write');
  const { flagId } = await params;
  const body = await parseJson(request, bodySchema);
  return ok({ flag: await resolveDuplicate(prisma, actor, { flagId, ...body }) });
});
