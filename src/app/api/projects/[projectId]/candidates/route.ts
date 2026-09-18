import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { searchExpertsForProject } from '@/server/services/matching';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ projectId: string }> };

/**
 * Search the whole network against one project's brief.
 *
 * Read-only: it scores and explains, and grants nothing. Inviting still goes
 * through `POST /api/projects/:id/invitations`, which re-checks eligibility.
 */
export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'project:read');
  const { projectId } = await params;
  const search = request.nextUrl.searchParams.get('search') ?? '';
  return ok({ matches: await searchExpertsForProject(prisma, projectId, { search }) });
});
