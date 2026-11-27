import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import {
  addAccessResource,
  confirmManualRevoke,
  listProjectAccess,
  removeAccessResource,
  retryAccessGrant,
} from '@/server/services/access';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ projectId: string }> };

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    system: z.enum(['GITHUB', 'SLACK']),
    resource: z.string().min(1).max(200),
    label: z.string().max(120).optional(),
    permission: z.enum(['pull', 'triage', 'push', 'maintain']).optional(),
  }),
  z.object({ action: z.literal('remove'), resourceId: z.string().min(1) }),
  z.object({ action: z.literal('retry'), grantId: z.string().min(1) }),
  z.object({
    action: z.literal('confirm_manual_revoke'),
    grantId: z.string().min(1),
    note: z.string().min(1).max(500),
  }),
]);

export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'access:read');
  const { projectId } = await params;
  return ok(await listProjectAccess(prisma, projectId));
});

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'access:manage');
  const { projectId } = await params;
  const body = await parseJson(request, bodySchema);

  // Grant and resource ids are checked against the project in the path, so a
  // request cannot act on another project's access through this URL.
  async function assertGrantOnProject(grantId: string) {
    const grant = await prisma.accessGrant.findUnique({ where: { id: grantId } });
    if (!grant || grant.projectId !== projectId) throw notFound('Access grant not found.');
  }

  switch (body.action) {
    case 'add':
      return ok({ resource: await addAccessResource(prisma, actor, { projectId, ...body }) }, 201);
    case 'remove': {
      const resource = await prisma.projectAccessResource.findUnique({
        where: { id: body.resourceId },
      });
      if (!resource || resource.projectId !== projectId)
        throw notFound('Access resource not found.');
      return ok({ resource: await removeAccessResource(prisma, actor, body.resourceId) });
    }
    case 'retry':
      await assertGrantOnProject(body.grantId);
      return ok(await retryAccessGrant(prisma, actor, body.grantId));
    case 'confirm_manual_revoke':
      await assertGrantOnProject(body.grantId);
      return ok(await confirmManualRevoke(prisma, actor, body.grantId, body.note));
  }
});
