import { type Prisma } from '@prisma/client';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { forbidden, invalidState, notFound } from '@/lib/errors';
import { minorToPlainDecimal } from '@/lib/decimal';
import {
  describeStripeError,
  type ConnectedAccountState,
  type PayoutGateway,
} from '@/server/integrations/stripe';
import { type Actor, recordActivity } from './activity';

/**
 * Paying experts through Stripe Connect (test mode).
 *
 * The flow:
 *
 *  1. An expert opens "Set up payouts" in their portal. A connected Express
 *     account is created once (idempotent per expert), and they are sent to
 *     Stripe's hosted onboarding. Stripe collects identity, bank details and,
 *     for US experts, the tax information behind a 1099. This system never
 *     sees any of it.
 *  2. Stripe reports the account's state by webhook (`account.updated`).
 *     `payoutsEnabled` mirrors it; nothing here guesses.
 *  3. An admin pays an APPROVED batch: one transfer per item, each with an
 *     idempotency key derived from the payment item, so a retry, a double
 *     click or a crash halfway can never pay an item twice.
 *
 * Money only moves in step 3, and only for a batch someone other than its
 * creator approved. Paying is an alternative to exporting the file, not an
 * addition: a batch ends either EXPORTED or PAID.
 */

// ---------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------

async function applyAccountState(db: Db, expertId: string, state: ConnectedAccountState) {
  return db.expert.update({
    where: { id: expertId },
    data: {
      stripeAccountId: state.id,
      payoutsEnabled: state.payoutsEnabled,
      payoutRequirementsDue: state.requirementsDue as Prisma.InputJsonValue,
      payoutStatusUpdatedAt: clockNow(),
    },
  });
}

/**
 * EXPERT ACTION. Create the expert's connected account if needed and return a
 * fresh onboarding link. Links expire within minutes, so one is made per click
 * rather than emailed.
 */
export async function startPayoutOnboarding(
  db: Db,
  gateway: PayoutGateway,
  actor: Actor,
  input: { expertId: string; returnUrl: string; refreshUrl: string; country: string },
): Promise<{ url: string; accountId: string }> {
  if (actor.type === 'EXPERT' && actor.expertId !== input.expertId) {
    throw forbidden('You can only set up your own payouts.');
  }
  const expert = await db.expert.findUnique({ where: { id: input.expertId } });
  if (!expert) throw notFound('Expert not found.');
  if (expert.status === 'ARCHIVED') throw invalidState('An archived expert cannot be paid.');

  let accountId = expert.stripeAccountId;
  if (!accountId) {
    const state = await gateway.createAccount({
      email: expert.email,
      country: input.country,
      metadata: { expertId: expert.id, expertReference: expert.reference },
      // One account per expert, even if they click twice before the first
      // request returns.
      idempotencyKey: `expert-account-${expert.id}`,
    });
    await applyAccountState(db, expert.id, state);
    accountId = state.id;
    await recordActivity(db, {
      actor,
      entityType: 'expert',
      entityId: expert.id,
      expertId: expert.id,
      action: 'payout.account_created',
      summary: `A Stripe test-mode payout account was created for ${expert.fullName}`,
      metadata: { accountId },
    });
  }

  const url = await gateway.createOnboardingLink({
    accountId,
    returnUrl: input.returnUrl,
    refreshUrl: input.refreshUrl,
  });
  return { url, accountId };
}

/** Webhook: mirror Stripe's view of a connected account. */
export async function syncConnectedAccount(db: Db, state: ConnectedAccountState) {
  const expert = await db.expert.findUnique({ where: { stripeAccountId: state.id } });
  if (!expert) return { matched: false as const };

  const becameEnabled = state.payoutsEnabled && !expert.payoutsEnabled;
  await applyAccountState(db, expert.id, state);
  if (becameEnabled || (!state.payoutsEnabled && expert.payoutsEnabled)) {
    await recordActivity(db, {
      actor: { type: 'SYSTEM', label: 'Stripe' },
      entityType: 'expert',
      entityId: expert.id,
      expertId: expert.id,
      action: becameEnabled ? 'payout.enabled' : 'payout.disabled',
      summary: becameEnabled
        ? `${expert.fullName} can now receive payouts`
        : `Payouts to ${expert.fullName} were paused by Stripe (${state.requirementsDue.length} requirement(s) due)`,
      metadata: { accountId: state.id, requirementsDue: state.requirementsDue },
    });
  }
  return { matched: true as const, expertId: expert.id, payoutsEnabled: state.payoutsEnabled };
}

// ---------------------------------------------------------------------------
// Paying a batch
// ---------------------------------------------------------------------------

export interface PayBatchResult {
  batchStatus: 'PAYING' | 'PAID';
  paid: number;
  alreadyPaid: number;
  failed: Array<{ reference: string; error: string }>;
}

/**
 * HUMAN DECISION. Pay an approved batch by Stripe transfer.
 *
 * Refuses to start unless every expert in the batch can receive payouts, so a
 * batch is never half-paid because someone had not finished onboarding. Once
 * started (PAYING) it can only finish: each run transfers the items not yet
 * paid, and a failed transfer is recorded on its item and retried next run.
 *
 * Deliberately not one database transaction: each transfer is a real side
 * effect, so each item is recorded as soon as its own transfer succeeds.
 */
export async function payBatch(
  db: Db,
  gateway: PayoutGateway,
  actor: Actor,
  batchId: string,
): Promise<PayBatchResult> {
  const batch = await db.paymentBatch.findUnique({
    where: { id: batchId },
    include: {
      items: {
        where: { status: { in: ['IN_BATCH', 'PAID'] } },
        include: { expert: true },
        orderBy: { reference: 'asc' },
      },
    },
  });
  if (!batch) throw notFound('Payment batch not found.');
  if (batch.status !== 'APPROVED' && batch.status !== 'PAYING') {
    throw invalidState(
      `Batch ${batch.reference} is ${batch.status}. Only an APPROVED batch can be paid.`,
      { status: batch.status },
    );
  }
  if (batch.items.length === 0) throw invalidState('This batch has no items to pay.');

  if (batch.status === 'APPROVED') {
    const notReady = batch.items
      .filter((item) => !item.expert.payoutsEnabled || !item.expert.stripeAccountId)
      .map((item) => item.expert.fullName);
    if (notReady.length > 0) {
      throw invalidState(
        `Not paid: ${[...new Set(notReady)].join(', ')} cannot receive payouts yet. Ask them to finish payout setup in their portal, or export the batch instead.`,
        { notReady: [...new Set(notReady)] },
      );
    }
    const started = await db.paymentBatch.updateMany({
      where: { id: batchId, status: 'APPROVED' },
      data: { status: 'PAYING', paidById: actor.userId ?? null },
    });
    if (started.count === 0) throw invalidState('This batch was already exported or paid.');
    await recordActivity(db, {
      actor,
      entityType: 'payment_batch',
      entityId: batchId,
      action: 'payment.batch_paying',
      summary: `${actor.label} started paying batch ${batch.reference} by Stripe transfer (test mode): ${batch.items.length} item(s), ${minorToPlainDecimal(batch.totalMinor)} ${batch.currency}`,
      metadata: { itemCount: batch.items.length, totalMinor: batch.totalMinor, mode: gateway.mode },
    });
  }

  const result: PayBatchResult = { batchStatus: 'PAYING', paid: 0, alreadyPaid: 0, failed: [] };
  for (const item of batch.items) {
    if (item.status === 'PAID') {
      result.alreadyPaid += 1;
      continue;
    }
    // Re-checked on every run, not only when the batch starts: Stripe can pause
    // an account between runs, and a transfer to it would fail anyway.
    if (!item.expert.stripeAccountId || !item.expert.payoutsEnabled) {
      const error = item.expert.stripeAccountId
        ? `Payouts to ${item.expert.fullName} are paused by Stripe. They need to finish the outstanding steps in their portal.`
        : `${item.expert.fullName} has no payout account.`;
      await db.paymentItem.update({ where: { id: item.id }, data: { payoutError: error } });
      result.failed.push({ reference: item.reference, error });
      continue;
    }
    try {
      const transfer = await gateway.createTransfer({
        amountMinor: item.amountMinor,
        currency: item.currency,
        destination: item.expert.stripeAccountId,
        group: batch.reference,
        description: `${item.reference} for ${item.expert.reference}`,
        metadata: {
          paymentItemId: item.id,
          paymentReference: item.reference,
          batch: batch.reference,
        },
        idempotencyKey: `payment-item-${item.id}`,
      });
      const marked = await db.paymentItem.updateMany({
        where: { id: item.id, status: 'IN_BATCH' },
        data: {
          status: 'PAID',
          stripeTransferId: transfer.id,
          paidAt: clockNow(),
          payoutError: null,
        },
      });
      if (marked.count === 1) result.paid += 1;
      else result.alreadyPaid += 1;
    } catch (error) {
      const message = describeStripeError(error).slice(0, 500);
      await db.paymentItem.update({ where: { id: item.id }, data: { payoutError: message } });
      result.failed.push({ reference: item.reference, error: message });
    }
  }

  const unpaid = await db.paymentItem.count({ where: { batchId, status: 'IN_BATCH' } });
  if (unpaid === 0) {
    const finished = await db.paymentBatch.updateMany({
      where: { id: batchId, status: 'PAYING' },
      data: { status: 'PAID', paidAt: clockNow() },
    });
    if (finished.count === 1) {
      await recordActivity(db, {
        actor,
        entityType: 'payment_batch',
        entityId: batchId,
        action: 'payment.batch_paid',
        summary: `Batch ${batch.reference} is fully paid by Stripe transfer (test mode)`,
        metadata: {
          itemCount: batch.items.length,
          totalMinor: batch.totalMinor,
          mode: gateway.mode,
        },
      });
    }
    result.batchStatus = 'PAID';
  }
  return result;
}
