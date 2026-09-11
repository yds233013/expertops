import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { created, ok, parseJson, route } from '@/server/http/respond';
import { createExpert, listExperts } from '@/server/services/experts';
import { type ExpertStatus } from '@prisma/client';

export const dynamic = 'force-dynamic';

const skillSchema = z.object({
  name: z.string().min(1).max(80),
  proficiency: z.number().int().min(1).max(5).optional(),
  yearsUsed: z.number().int().min(0).max(60).optional(),
});

const createSchema = z.object({
  fullName: z.string().min(1).max(160),
  email: z.string().email(),
  headline: z.string().min(1).max(200),
  bio: z.string().max(4000).optional(),
  yearsExperience: z.number().int().min(0).max(60).optional(),
  timezone: z.string().max(64).optional(),
  hourlyRateCents: z.number().int().min(0).max(10_000_00).optional(),
  currency: z.string().length(3).optional(),
  weeklyCapacityHours: z.number().int().min(0).max(60).optional(),
  notes: z.string().max(4000).optional(),
  skills: z.array(skillSchema).max(30).optional(),
});

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'expert:read');
  const params = request.nextUrl.searchParams;
  const status = params.get('status');

  const result = await listExperts(prisma, {
    status: status ? (status as ExpertStatus) : undefined,
    search: params.get('search') ?? undefined,
    skillSlugs: params.getAll('skill'),
    limit: params.get('limit') ? Number(params.get('limit')) : undefined,
    cursor: params.get('cursor') ?? undefined,
  });

  return ok(result);
});

export const POST = route(async (request: NextRequest) => {
  const { actor } = await requireCapabilityFromRequest(request, 'expert:write');
  const body = await parseJson(request, createSchema);
  const expert = await createExpert(prisma, actor, body);
  return created({ expert });
});
