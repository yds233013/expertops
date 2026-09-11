import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { getExpert, updateExpert } from '@/server/services/experts';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ expertId: string }> };

const updateSchema = z.object({
  fullName: z.string().min(1).max(160).optional(),
  headline: z.string().min(1).max(200).optional(),
  bio: z.string().max(4000).optional(),
  yearsExperience: z.number().int().min(0).max(60).optional(),
  timezone: z.string().max(64).optional(),
  hourlyRateCents: z.number().int().min(0).max(10_000_00).optional(),
  currency: z.string().length(3).optional(),
  weeklyCapacityHours: z.number().int().min(0).max(60).optional(),
  notes: z.string().max(4000).optional(),
  skills: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        proficiency: z.number().int().min(1).max(5).optional(),
        yearsUsed: z.number().int().min(0).max(60).optional(),
      }),
    )
    .max(30)
    .optional(),
});

export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'expert:read');
  const { expertId } = await params;
  return ok({ expert: await getExpert(prisma, expertId) });
});

export const PATCH = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'expert:write');
  const { expertId } = await params;
  const body = await parseJson(request, updateSchema);
  return ok({ expert: await updateExpert(prisma, actor, expertId, body) });
});
