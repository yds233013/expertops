import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireExpertFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { listExpertAccess, setGithubUsername } from '@/server/services/access';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ githubUsername: z.string().max(60).nullable() });

/** The expert's own access: what they have been given, and to which account. */
export const GET = route(async (request: NextRequest) => {
  const { expert } = await requireExpertFromRequest(request);
  const grants = await listExpertAccess(prisma, expert.id);
  return ok({
    githubUsername: expert.githubUsername,
    grants: grants.map((grant) => ({
      id: grant.id,
      system: grant.system,
      resource:
        grant.resource.system === 'GITHUB'
          ? grant.resource.resource
          : grant.resource.label || 'Slack channel',
      project: grant.project.code,
      status: grant.status,
      invitationPending: grant.invitationPending,
    })),
  });
});

/** Scoped to the session's own expert; the id never comes from the body. */
export const PUT = route(async (request: NextRequest) => {
  const { expert, actor } = await requireExpertFromRequest(request);
  const body = await parseJson(request, bodySchema);
  const updated = await setGithubUsername(prisma, actor, expert.id, body.githubUsername);
  return ok({ githubUsername: updated.githubUsername });
});
