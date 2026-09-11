import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { retryJob } from '@/server/services/jobs';

type Params = { params: Promise<{ jobId: string }> };

export const POST = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'jobs:manage');
  const { jobId } = await params;
  return ok({ job: await retryJob(prisma, jobId) });
});
