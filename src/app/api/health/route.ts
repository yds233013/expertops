import { prisma } from '@/lib/db';
import { ok, route } from '@/server/http/respond';

export const dynamic = 'force-dynamic';

/** Liveness + database reachability. Used by the smoke script. */
export const GET = route(async () => {
  const startedAt = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  const [experts, projects, pendingJobs] = await Promise.all([
    prisma.expert.count(),
    prisma.project.count(),
    prisma.job.count({ where: { status: { in: ['PENDING', 'FAILED'] } } }),
  ]);
  return ok({
    status: 'ok',
    databaseLatencyMs: Date.now() - startedAt,
    counts: { experts, projects, pendingJobs },
  });
});
