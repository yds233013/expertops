import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireExpertFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { respondToInvitation } from '@/server/services/invitations';

type Params = { params: Promise<{ invitationId: string }> };

const bodySchema = z.object({
  accept: z.boolean(),
  declineReason: z.string().max(500).optional(),
});

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { expert } = await requireExpertFromRequest(request);
  const { invitationId } = await params;
  const body = await parseJson(request, bodySchema);
  const invitation = await respondToInvitation(prisma, expert.id, { invitationId, ...body });
  return ok({ invitation });
});
