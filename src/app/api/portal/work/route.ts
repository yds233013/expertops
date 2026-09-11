import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireExpertFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { listWorkItemsForExpert } from '@/server/services/work';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const { expert } = await requireExpertFromRequest(request);
  return ok({ items: await listWorkItemsForExpert(prisma, expert.id) });
});
