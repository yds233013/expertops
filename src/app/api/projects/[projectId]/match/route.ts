import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { created, ok, parseJson, route } from '@/server/http/respond';
import { getLatestMatchRun, runMatching } from '@/server/services/matching';

type Params = { params: Promise<{ projectId: string }> };

const bodySchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  includeExcluded: z.boolean().optional(),
  hoursPerWeekNeeded: z.number().int().min(1).max(60).optional(),
  weights: z
    .object({
      requiredSkills: z.number().min(0).max(100).optional(),
      optionalSkills: z.number().min(0).max(100).optional(),
      seniority: z.number().min(0).max(100).optional(),
      rate: z.number().min(0).max(100).optional(),
      availability: z.number().min(0).max(100).optional(),
      standing: z.number().min(0).max(100).optional(),
    })
    .optional(),
});

export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'project:read');
  const { projectId } = await params;
  return ok({ matchRun: await getLatestMatchRun(prisma, projectId) });
});

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'matching:run');
  const { projectId } = await params;
  const body = await parseJson(request, bodySchema.optional().default({}));
  const matchRun = await runMatching(prisma, actor, projectId, body);
  return created({ matchRun });
});
