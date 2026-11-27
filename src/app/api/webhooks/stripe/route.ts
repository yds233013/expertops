import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { claimWebhookEvent } from '@/server/integrations/webhooks';
import { accountState, constructStripeEvent, stripeConfig } from '@/server/integrations/stripe';
import { syncConnectedAccount } from '@/server/services/payouts';

export const dynamic = 'force-dynamic';

/**
 * Stripe events for connected accounts.
 *
 * Authenticated only by the `stripe-signature` header, checked by the SDK
 * against the raw body. A redelivered event is acknowledged without being
 * applied again. Only `account.updated` changes anything.
 */
export async function POST(request: NextRequest) {
  const config = stripeConfig();
  if (!config.webhookSecret) {
    return NextResponse.json({ error: 'STRIPE_WEBHOOK_SECRET is not set.' }, { status: 503 });
  }

  const body = await request.text();
  let event;
  try {
    event = constructStripeEvent(
      body,
      request.headers.get('stripe-signature'),
      config.webhookSecret,
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid signature.' },
      { status: 401 },
    );
  }

  const outcome = await prisma.$transaction(async (tx) => {
    if (
      !(await claimWebhookEvent(tx, { provider: 'stripe', eventId: event.id, type: event.type }))
    ) {
      return 'duplicate';
    }
    if (event.type !== 'account.updated') return 'ignored';
    const synced = await syncConnectedAccount(tx, accountState(event.data.object));
    return synced.matched ? 'synced' : 'unknown_account';
  });
  return NextResponse.json({ received: true, outcome });
}
