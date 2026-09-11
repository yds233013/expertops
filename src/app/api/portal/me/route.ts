import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireExpertFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { listInvitationsForExpert } from '@/server/services/invitations';
import { listAvailability } from '@/server/services/availability';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const { expert } = await requireExpertFromRequest(request);
  const [invitations, availability, onboardingCase] = await Promise.all([
    listInvitationsForExpert(prisma, expert.id),
    listAvailability(prisma, expert.id),
    prisma.onboardingCase.findUnique({
      where: { expertId: expert.id },
      include: { items: { orderBy: { position: 'asc' } } },
    }),
  ]);
  return ok({ expert, invitations, availability, onboardingCase });
});
