import { type NextRequest } from 'next/server';
import { type JobStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { jobCounts, listJobs } from '@/server/services/jobs';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'jobs:read');
  const params = request.nextUrl.searchParams;
  const status = params.get('status');
  const [result, counts] = await Promise.all([
    listJobs(prisma, {
      status: status ? (status as JobStatus) : undefined,
      type: params.get('type') ?? undefined,
      limit: params.get('limit') ? Number(params.get('limit')) : undefined,
      cursor: params.get('cursor') ?? undefined,
    }),
    jobCounts(prisma),
  ]);
  return ok({ ...result, counts });
});
