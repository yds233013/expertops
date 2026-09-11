import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { listSchedules, scheduleDescription } from '@/server/services/schedules';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'jobs:read');
  const schedules = await listSchedules(prisma);
  return ok({
    schedules: schedules.map((schedule) => ({
      ...schedule,
      description: scheduleDescription(schedule.name),
    })),
  });
});
