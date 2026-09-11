import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { decideVerification } from '@/server/services/onboarding';
import { queueMessage } from '@/server/services/outbox';
import {
  renderOnboardingRejectedEmail,
  renderOnboardingVerifiedEmail,
} from '@/server/email/templates';

type Params = { params: Promise<{ expertId: string }> };

const bodySchema = z.object({
  approve: z.boolean(),
  note: z.string().max(1000).optional(),
});

/**
 * HUMAN OPERATOR CONFIRMATION endpoint.
 *
 * Verification is never automatic. The decision, the operator identity and the
 * note are recorded by the onboarding service; this handler only adapts HTTP to
 * that service and queues the resulting simulated email.
 */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor, operator } = await requireCapabilityFromRequest(request, 'onboarding:verify');
  const { expertId } = await params;
  const body = await parseJson(request, bodySchema);

  const decided = await decideVerification(prisma, actor, {
    expertId,
    approve: body.approve,
    note: body.note,
  });

  const rendered = body.approve
    ? renderOnboardingVerifiedEmail({
        expertName: decided.expert.fullName,
        operatorName: operator.name,
        note: body.note ?? null,
      })
    : renderOnboardingRejectedEmail({
        expertName: decided.expert.fullName,
        operatorName: operator.name,
        note: body.note ?? null,
      });

  await queueMessage(prisma, {
    toEmail: decided.expert.email,
    toName: decided.expert.fullName,
    subject: rendered.subject,
    bodyText: rendered.bodyText,
    template: body.approve ? 'onboarding.verified' : 'onboarding.rejected',
    relatedType: 'onboarding',
    relatedId: decided.id,
    expertId,
  });

  return ok({ onboardingCase: decided });
});
