import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { listExpertAccess, setGithubUsername } from '@/server/services/access';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ expertId: string }> };

const bodySchema = z.object({ githubUsername: z.string().max(60).nullable() });

export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'access:read');
  const { expertId } = await params;
  return ok({ grants: await listExpertAccess(prisma, expertId) });
});

/** Set the GitHub username access is granted to. Changing it moves access. */
export const PUT = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'access:manage');
  const { expertId } = await params;
  const body = await parseJson(request, bodySchema);
  const expert = await setGithubUsername(prisma, actor, expertId, body.githubUsername);
  return ok({ githubUsername: expert.githubUsername });
});
