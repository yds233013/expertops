import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Db } from '@/lib/db';

/**
 * Shared webhook plumbing: signature checks and once-only processing.
 *
 * A webhook endpoint has no session and no CSRF token. Its only credential is
 * the signature, so every handler verifies it against the raw body before
 * parsing anything, and refuses old timestamps so a captured request cannot be
 * replayed later.
 */

/** Signatures older or newer than this are refused. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export class WebhookSignatureError extends Error {}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verify a Svix-signed webhook (the scheme Resend uses).
 *
 * The signed content is `${svix-id}.${svix-timestamp}.${body}`, HMAC-SHA256
 * with the base64 key after the `whsec_` prefix. `svix-signature` holds one or
 * more space-separated `v1,<base64>` entries; any match is accepted, which is
 * how secret rotation works.
 */
export function verifySvixSignature(input: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: Date;
}): void {
  const { id, timestamp, signature } = input;
  if (!id || !timestamp || !signature) {
    throw new WebhookSignatureError('Missing svix-id, svix-timestamp or svix-signature.');
  }
  const seconds = Number(timestamp);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(seconds) || Math.abs(nowSeconds - seconds) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new WebhookSignatureError('The webhook timestamp is outside the allowed window.');
  }

  const key = Buffer.from(input.secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${input.body}`)
    .digest('base64');

  const matches = signature
    .split(' ')
    .map((entry) => entry.split(','))
    .some(
      ([version, value]) => version === 'v1' && value !== undefined && safeEqual(value, expected),
    );
  if (!matches) throw new WebhookSignatureError('The webhook signature does not match.');
}

/**
 * Record that an event was processed. Returns false if it already was.
 *
 * Call it inside the same transaction as the event's effects: if they roll
 * back, so does the receipt, and the provider's retry is processed for real.
 */
export async function claimWebhookEvent(
  db: Db,
  input: { provider: string; eventId: string; type: string },
): Promise<boolean> {
  // ON CONFLICT DO NOTHING rather than catching a unique violation: inside a
  // PostgreSQL transaction a failed statement aborts everything after it.
  const result = await db.webhookEvent.createMany({ data: [input], skipDuplicates: true });
  return result.count === 1;
}
