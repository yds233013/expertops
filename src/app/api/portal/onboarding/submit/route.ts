import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireExpertFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { submitOnboarding } from '@/server/services/onboarding';

/**
 * Expert submits their checklist. This does NOT verify them: an operator must
 * confirm the submission via POST /api/experts/:id/verify.
 */
export const POST = route(async (request: NextRequest) => {
  const { expert, actor } = await requireExpertFromRequest(request);
  const onboardingCase = await submitOnboarding(prisma, actor, expert.id);
  return ok({ onboardingCase, awaitingOperatorVerification: true });
});
