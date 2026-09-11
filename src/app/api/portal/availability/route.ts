import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireExpertFromRequest } from '@/server/http/context';
import { created, ok, parseJson, route } from '@/server/http/respond';
import { declareAvailability, listAvailability } from '@/server/services/availability';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  hoursPerWeek: z.number().int().min(1).max(60),
  projectId: z.string().nullable().optional(),
  note: z.string().max(500).optional(),
});

export const GET = route(async (request: NextRequest) => {
  const { expert } = await requireExpertFromRequest(request);
  return ok({ availability: await listAvailability(prisma, expert.id) });
});

export const POST = route(async (request: NextRequest) => {
  const { expert, actor } = await requireExpertFromRequest(request);
  const body = await parseJson(request, bodySchema);
  const window = await declareAvailability(prisma, actor, expert.id, body);
  return created({ window });
});
