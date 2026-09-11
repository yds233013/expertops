import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireExpertFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { getOnboardingCase, saveChecklistAnswers } from '@/server/services/onboarding';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  answers: z
    .array(z.object({ key: z.string().min(1).max(64), value: z.string().max(2000) }))
    .min(1)
    .max(30),
});

export const GET = route(async (request: NextRequest) => {
  const { expert } = await requireExpertFromRequest(request);
  return ok({ onboardingCase: await getOnboardingCase(prisma, expert.id) });
});

export const PATCH = route(async (request: NextRequest) => {
  const { expert, actor } = await requireExpertFromRequest(request);
  const body = await parseJson(request, bodySchema);
  const onboardingCase = await saveChecklistAnswers(prisma, actor, expert.id, body.answers);
  return ok({ onboardingCase });
});
