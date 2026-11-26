import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { recordActivity, SYSTEM_ACTOR } from '@/server/services/activity';
import { claimWebhookEvent } from './webhooks';

/**
 * Apply one Resend webhook event to the outbox.
 *
 * Only the events that change what the system should do next are acted on:
 * delivery is recorded, and a bounce or a spam complaint puts the address on
 * the suppression list so nothing is sent to it again. Everything else is
 * acknowledged and ignored. Run inside one transaction with the receipt.
 */
export interface ResendEvent {
  type: string;
  created_at?: string;
  data?: { email_id?: string; to?: string[] };
}

export type ResendEventOutcome =
  'duplicate' | 'ignored' | 'unknown_message' | 'delivered' | 'bounced' | 'complained';

export async function applyResendEvent(
  db: Db,
  eventId: string,
  event: ResendEvent,
  options: { now?: Date } = {},
): Promise<ResendEventOutcome> {
  if (!(await claimWebhookEvent(db, { provider: 'resend', eventId, type: event.type }))) {
    return 'duplicate';
  }
  const handled = ['email.delivered', 'email.bounced', 'email.complained'];
  if (!handled.includes(event.type)) return 'ignored';

  const providerMessageId = event.data?.email_id;
  const message = providerMessageId
    ? await db.outboxMessage.findFirst({ where: { provider: 'resend', providerMessageId } })
    : null;
  if (!message) return 'unknown_message';

  const at = options.now ?? clockNow();
  if (event.type === 'email.delivered') {
    await db.outboxMessage.update({ where: { id: message.id }, data: { deliveredAt: at } });
    return 'delivered';
  }

  const bounced = event.type === 'email.bounced';
  if (bounced) {
    await db.outboxMessage.update({
      where: { id: message.id },
      data: { status: 'BOUNCED', bouncedAt: at },
    });
  }
  const email = message.toEmail.toLowerCase();
  await db.emailSuppression.createMany({
    data: [{ email, reason: bounced ? 'BOUNCE' : 'COMPLAINT', source: `resend:${eventId}` }],
    skipDuplicates: true,
  });
  await recordActivity(db, {
    actor: SYSTEM_ACTOR,
    entityType: 'outbox_message',
    entityId: message.id,
    expertId: message.expertId,
    projectId: message.projectId,
    action: bounced ? 'outbox.bounced' : 'outbox.complained',
    summary: bounced
      ? `Email to ${message.toEmail} bounced; the address is now suppressed`
      : `${message.toEmail} marked an email as spam; the address is now suppressed`,
    metadata: { providerMessageId, eventId },
  });
  return bounced ? 'bounced' : 'complained';
}
