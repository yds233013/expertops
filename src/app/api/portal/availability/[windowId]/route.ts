import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireExpertFromRequest } from '@/server/http/context';
import { noContent, route } from '@/server/http/respond';
import { removeAvailability } from '@/server/services/availability';

type Params = { params: Promise<{ windowId: string }> };

export const DELETE = route(async (request: NextRequest, { params }: Params) => {
  const { expert, actor } = await requireExpertFromRequest(request);
  const { windowId } = await params;
  await removeAvailability(prisma, actor, expert.id, windowId);
  return noContent();
});
