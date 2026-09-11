import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { getProject, updateProject } from '@/server/services/projects';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ projectId: string }> };

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  clientName: z.string().min(1).max(160).optional(),
  description: z.string().max(8000).optional(),
  seatsRequested: z.number().int().min(1).max(50).optional(),
  minYearsExperience: z.number().int().min(0).max(60).optional(),
  maxHourlyRateCents: z.number().int().min(0).max(10_000_00).nullable().optional(),
  preferredTimezone: z.string().max(64).optional(),
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
  requirements: z
    .array(
      z.object({
        skillName: z.string().min(1).max(80),
        required: z.boolean().optional(),
        minProficiency: z.number().int().min(1).max(5).optional(),
        weight: z.number().int().min(1).max(5).optional(),
      }),
    )
    .max(20)
    .optional(),
});

export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'project:read');
  const { projectId } = await params;
  return ok({ project: await getProject(prisma, projectId) });
});

export const PATCH = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'project:write');
  const { projectId } = await params;
  const body = await parseJson(request, updateSchema);
  return ok({ project: await updateProject(prisma, actor, projectId, body) });
});
