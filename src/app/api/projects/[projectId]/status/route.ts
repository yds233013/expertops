import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { ProjectStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { setProjectStatus } from '@/server/services/projects';

type Params = { params: Promise<{ projectId: string }> };

const bodySchema = z.object({
  status: z.enum(Object.values(ProjectStatus) as [string, ...string[]]),
  reason: z.string().max(500).optional(),
});

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'project:status');
  const { projectId } = await params;
  const body = await parseJson(request, bodySchema);
  const project = await setProjectStatus(prisma, actor, projectId, body.status as ProjectStatus, {
    reason: body.reason,
  });
  return ok({ project });
});
