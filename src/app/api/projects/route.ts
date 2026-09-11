import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { type ProjectStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { created, ok, parseJson, route } from '@/server/http/respond';
import { createProject, listProjects } from '@/server/services/projects';

export const dynamic = 'force-dynamic';

const requirementSchema = z.object({
  skillName: z.string().min(1).max(80),
  required: z.boolean().optional(),
  minProficiency: z.number().int().min(1).max(5).optional(),
  weight: z.number().int().min(1).max(5).optional(),
});

const createSchema = z.object({
  title: z.string().min(1).max(200),
  clientName: z.string().min(1).max(160),
  description: z.string().max(8000).optional(),
  seatsRequested: z.number().int().min(1).max(50).optional(),
  minYearsExperience: z.number().int().min(0).max(60).optional(),
  maxHourlyRateCents: z.number().int().min(0).max(10_000_00).nullable().optional(),
  preferredTimezone: z.string().max(64).optional(),
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
  requirements: z.array(requirementSchema).max(20).optional(),
});

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'project:read');
  const params = request.nextUrl.searchParams;
  const status = params.get('status');
  const result = await listProjects(prisma, {
    status: status ? (status as ProjectStatus) : undefined,
    search: params.get('search') ?? undefined,
    limit: params.get('limit') ? Number(params.get('limit')) : undefined,
    cursor: params.get('cursor') ?? undefined,
  });
  return ok(result);
});

export const POST = route(async (request: NextRequest) => {
  const { actor } = await requireCapabilityFromRequest(request, 'project:write');
  const body = await parseJson(request, createSchema);
  const project = await createProject(prisma, actor, body);
  return created({ project });
});
