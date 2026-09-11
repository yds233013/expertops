import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { created, ok, parseJson, route } from '@/server/http/respond';
import { listAssignmentsForProject, proposeAssignment } from '@/server/services/staffing';

type Params = { params: Promise<{ projectId: string }> };

const bodySchema = z.object({
  expertId: z.string().min(1),
  allocationHoursPerWeek: z.number().int().min(1).max(60),
  rateCents: z.number().int().min(0).max(10_000_00).optional(),
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
});

export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'project:read');
  const { projectId } = await params;
  return ok({ assignments: await listAssignmentsForProject(prisma, projectId) });
});

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'staffing:propose');
  const { projectId } = await params;
  const body = await parseJson(request, bodySchema);
  const assignment = await proposeAssignment(prisma, actor, { projectId, ...body });
  return created({ assignment });
});
