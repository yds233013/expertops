import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { withdrawInvitation } from '@/server/services/invitations';

type Params = { params: Promise<{ invitationId: string }> };

const bodySchema = z.object({ reason: z.string().min(1).max(500) });

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'invitation:withdraw');
  const { invitationId } = await params;
  const body = await parseJson(request, bodySchema);
  return ok({ invitation: await withdrawInvitation(prisma, actor, invitationId, body.reason) });
});
