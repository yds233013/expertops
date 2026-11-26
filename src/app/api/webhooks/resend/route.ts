import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { emailConfig } from '@/server/email/provider';
import { applyResendEvent, type ResendEvent } from '@/server/integrations/resend-events';
import { verifySvixSignature, WebhookSignatureError } from '@/server/integrations/webhooks';

export const dynamic = 'force-dynamic';

/**
 * Resend delivery events.
 *
 * No session: the Svix signature is the credential, checked against the raw
 * body before anything is parsed. A redelivered event is acknowledged without
 * being applied again. 503 when no secret is configured, so a misconfigured
 * deployment fails loudly instead of accepting unsigned requests.
 */
export async function POST(request: NextRequest) {
  const secret = emailConfig().webhookSecret;
  if (!secret) {
    return NextResponse.json({ error: 'RESEND_WEBHOOK_SECRET is not set.' }, { status: 503 });
  }

  const body = await request.text();
  const id = request.headers.get('svix-id');
  try {
    verifySvixSignature({
      secret,
      id,
      timestamp: request.headers.get('svix-timestamp'),
      signature: request.headers.get('svix-signature'),
      body,
    });
  } catch (error) {
    if (error instanceof WebhookSignatureError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    throw error;
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(body) as ResendEvent;
  } catch {
    return NextResponse.json({ error: 'The body is not JSON.' }, { status: 400 });
  }
  if (typeof event?.type !== 'string') {
    return NextResponse.json({ error: 'The event has no type.' }, { status: 400 });
  }

  const outcome = await prisma.$transaction((tx) => applyResendEvent(tx, id as string, event));
  return NextResponse.json({ received: true, outcome });
}
