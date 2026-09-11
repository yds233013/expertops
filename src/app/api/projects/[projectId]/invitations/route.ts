import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { created, ok, parseJson, route } from '@/server/http/respond';
import { createInvitation, listInvitationsForProject } from '@/server/services/invitations';

type Params = { params: Promise<{ projectId: string }> };

const bodySchema = z.object({
  expertId: z.string().min(1),
  message: z.string().max(2000).optional(),
  ttlHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional(),
  matchCandidateId: z.string().nullable().optional(),
});

export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'project:read');
  const { projectId } = await params;
  return ok({ invitations: await listInvitationsForProject(prisma, projectId) });
});

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'invitation:send');
  const { projectId } = await params;
  const body = await parseJson(request, bodySchema);
  const invitation = await createInvitation(prisma, actor, { projectId, ...body });
  return created({ invitation });
});
