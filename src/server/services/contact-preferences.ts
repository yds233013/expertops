import { type ContactPreference } from '@prisma/client';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, notFound } from '@/lib/errors';
import { recordActivity, type Actor } from './activity';
import { queueMessage, queueMessageOnce, type QueueMessageInput } from './outbox';

/**
 * What an expert has said about being contacted, and the one place that decides
 * whether a message may be queued for them.
 *
 * Two rules shape everything here.
 *
 * **Unknown is not yes.** Every record that existed before the field did carries
 * `UNKNOWN`, and nothing backfills it from the free-text notes. A sentence
 * somebody typed about preferring email is not a preference they set, and
 * parsing it as one would manufacture consent out of prose.
 *
 * **The check happens at the moment of queuing, not before.** A preference read
 * when a job was enqueued is a preference as it was minutes or hours ago. An
 * expert who opts out while a reminder sits in the queue has opted out, and the
 * only way to honour that is to re-read the record immediately before writing
 * the message — inside the same transaction that writes it.
 */

/** Why a message is being sent, which is what the preference discriminates on. */
export type MessageKind =
  /**
   * Something the person has to act on or needs to know: an invitation, a
   * decision, a seat confirmed or released, onboarding opening.
   */
  | 'OPERATIONAL'
  /**
   * Us chasing someone who has not answered. Optional by definition, which is
   * why it is the first thing a preference switches off.
   */
  | 'REMINDER';

export const CONTACT_PREFERENCE_LABEL: Record<ContactPreference, string> = {
  UNKNOWN: 'Not asked yet',
  EMAIL_ALL: 'Email, including reminders',
  EMAIL_ESSENTIAL: 'Email about invitations and decisions only',
  NO_CONTACT: 'Do not contact',
};

export const CONTACT_PREFERENCE_HELP: Record<ContactPreference, string> = {
  UNKNOWN:
    'Nobody has asked. Messages they have to act on still go; reminders do not, because chasing somebody whose preference we never asked is the part worth being careful about.',
  EMAIL_ALL: 'Everything, including reminders when something is waiting on them.',
  EMAIL_ESSENTIAL: 'Invitations, decisions and seat changes. No reminders or nudges.',
  NO_CONTACT:
    'No messages at all. They are also excluded from matching, because there would be no way to reach them about a result.',
};

export const SETTABLE_PREFERENCES: ContactPreference[] = [
  'EMAIL_ALL',
  'EMAIL_ESSENTIAL',
  'NO_CONTACT',
];

/**
 * May we send this kind of message to somebody holding this preference?
 *
 * Pure, so the rule can be read in one place and tested without a database.
 */
export function mayContact(preference: ContactPreference, kind: MessageKind): boolean {
  if (preference === 'NO_CONTACT') return false;
  if (kind === 'OPERATIONAL') return true;
  return preference === 'EMAIL_ALL';
}

/** True when this expert is unreachable and should not be ranked for work. */
export function excludedFromMatching(preference: ContactPreference): boolean {
  return preference === 'NO_CONTACT';
}

export interface QueueExpertMessageInput extends Omit<QueueMessageInput, 'toEmail' | 'toName'> {
  expertId: string;
  kind: MessageKind;
  /** Falls back to the address on the record, which is the usual case. */
  toEmail?: string;
  toName?: string;
}

export interface QueueExpertMessageResult {
  queued: boolean;
  /** Set when nothing was written, and says which rule stopped it. */
  skippedReason: string | null;
  messageId: string | null;
}

/**
 * Queue a message for an expert, re-reading their preference first.
 *
 * Every expert-addressed message goes through here. The read is deliberately
 * inside this function rather than at the call site: a caller that loaded the
 * expert earlier is holding a stale answer, and the whole point of the recheck
 * is to close that window.
 *
 * Returns rather than throws when a preference blocks the message. A suppressed
 * reminder is a normal outcome, not a failure — the job that asked for it has
 * done its work correctly by not sending it.
 */
export async function queueExpertMessage(
  db: Db,
  input: QueueExpertMessageInput,
): Promise<QueueExpertMessageResult> {
  const expert = await db.expert.findUnique({
    where: { id: input.expertId },
    select: { id: true, email: true, fullName: true, contactPreference: true, status: true },
  });
  if (!expert) throw notFound('Expert not found.');

  if (!mayContact(expert.contactPreference, input.kind)) {
    return {
      queued: false,
      skippedReason:
        expert.contactPreference === 'NO_CONTACT'
          ? 'The expert has asked not to be contacted.'
          : `Reminders are suppressed for this expert (${CONTACT_PREFERENCE_LABEL[expert.contactPreference].toLowerCase()}).`,
      messageId: null,
    };
  }

  const { expertId, kind, toEmail, toName, dedupeKey, ...rest } = input;
  void kind;
  const payload = {
    ...rest,
    toEmail: toEmail ?? expert.email,
    toName: toName ?? expert.fullName,
    expertId,
  };
  // A null from `queueMessageOnce` means the message already exists, which is
  // the same outcome the caller asked for.
  const message = dedupeKey
    ? await queueMessageOnce(db, { ...payload, dedupeKey })
    : await queueMessage(db, payload);
  return { queued: message !== null, skippedReason: null, messageId: message?.id ?? null };
}

export interface SetContactPreferenceInput {
  expertId: string;
  preference: ContactPreference;
  /** True when the expert set it themselves, which is the case that stamps a date. */
  setByExpert: boolean;
}

/**
 * Record a preference.
 *
 * `UNKNOWN` cannot be set. Moving somebody back to "we never asked" would be a
 * lie about the record, and there is no operational reason to want it: the way
 * to widen contact is to say so, not to forget.
 */
export async function setContactPreference(db: Db, actor: Actor, input: SetContactPreferenceInput) {
  if (!SETTABLE_PREFERENCES.includes(input.preference)) {
    throw badRequest('Choose one of the contact preferences. "Not asked yet" cannot be set.');
  }

  const expert = await db.expert.findUnique({ where: { id: input.expertId } });
  if (!expert) throw notFound('Expert not found.');
  if (expert.contactPreference === input.preference) return expert;

  const updated = await db.expert.update({
    where: { id: input.expertId },
    data: {
      contactPreference: input.preference,
      contactPreferenceSetAt: input.setByExpert ? clockNow() : expert.contactPreferenceSetAt,
    },
  });

  await recordActivity(db, {
    actor,
    entityType: 'expert',
    entityId: expert.id,
    expertId: expert.id,
    action: 'expert.contact_preference_set',
    summary: `${actor.label} set contact preference for ${expert.fullName} to "${CONTACT_PREFERENCE_LABEL[input.preference]}"`,
    metadata: {
      from: expert.contactPreference,
      to: input.preference,
      setByExpert: input.setByExpert,
    },
  });

  return updated;
}
