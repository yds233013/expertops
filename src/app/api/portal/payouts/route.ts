import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { requireExpertFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { payoutGateway, stripeConfig } from '@/server/integrations/stripe';
import { startPayoutOnboarding } from '@/server/services/payouts';

export const dynamic = 'force-dynamic';

/**
 * The expert starts (or resumes) Stripe payout onboarding. Returns a
 * short-lived Stripe-hosted URL; the browser goes there next.
 */
export const POST = route(async (request: NextRequest) => {
  const { expert, actor } = await requireExpertFromRequest(request);
  const config = stripeConfig();
  const base = getEnv().APP_BASE_URL.replace(/\/$/, '');
  const result = await startPayoutOnboarding(prisma, payoutGateway(config), actor, {
    expertId: expert.id,
    country: config.country,
    returnUrl: `${base}/portal?payouts=returned`,
    refreshUrl: `${base}/portal?payouts=expired`,
  });
  return ok({ url: result.url });
});
