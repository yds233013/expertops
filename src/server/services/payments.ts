import {
  type PaymentBatch,
  type PaymentBatchStatus,
  type PaymentItem,
  type PaymentItemStatus,
  type Prisma,
} from '@prisma/client';
import { type Db, isPrismaErrorCode, PG_UNIQUE_VIOLATION, type Transactor } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, conflict, forbidden, invalidState, notFound } from '@/lib/errors';
import { formatReference, parseReferenceSequence } from '@/lib/ids';
import {
  computeAmountMinor,
  minorToPlainDecimal,
  quantityToString,
  sumMinor,
  toQuantityScaled,
} from '@/lib/decimal';
import { toCsv } from '@/lib/csv';
import { type Actor, recordActivity } from './activity';

/**
 * Payment preparation.
 *
 * This produces a reviewed, approved file for a finance process that lives
 * somewhere else. It does not move money, and **exported is not paid**. There
 * is deliberately no "mark as paid" action, because this system has no way to
 * know whether a transfer actually settled.
 *
 * Three invariants:
 *
 *  * **Idempotent drafting.** One payment item per approved work review,
 *    enforced by a unique index, so a duplicate job delivery cannot double-pay.
 *  * **One active batch per item.** An item already sitting in a live batch
 *    cannot be added to a second one.
 *  * **Corrections preserve history.** A correction voids the original and
 *    links the replacement; nothing is edited in place, and any approval that
 *    covered the old figure is invalidated.
 */
export const PAYMENT_ITEM_PREFIX = 'PAY';
export const PAYMENT_BATCH_PREFIX = 'PB';

async function nextItemReference(db: Db): Promise<string> {
  const latest = await db.paymentItem.findFirst({
    orderBy: { reference: 'desc' },
    select: { reference: true },
  });
  return formatReference(
    PAYMENT_ITEM_PREFIX,
    parseReferenceSequence(PAYMENT_ITEM_PREFIX, latest?.reference) + 1,
  );
}

async function nextBatchReference(db: Db): Promise<string> {
  const latest = await db.paymentBatch.findFirst({
    orderBy: { reference: 'desc' },
    select: { reference: true },
  });
  return formatReference(
    PAYMENT_BATCH_PREFIX,
    parseReferenceSequence(PAYMENT_BATCH_PREFIX, latest?.reference) + 1,
  );
}

export interface Discrepancy {
  code: string;
  message: string;
}

export interface DraftResult {
  item: PaymentItem;
  created: boolean;
  discrepancies: Discrepancy[];
}

/**
 * Create a draft payment item from an approved work review.
 *
 * Idempotent: calling it twice for the same review returns the existing item.
 * That is what makes it safe for a job queue with at-least-once delivery.
 */
export async function draftPaymentFromApprovedWork(
  db: Db,
  actor: Actor,
  input: { workItemId: string },
): Promise<DraftResult> {
  const workItem = await db.workItem.findUnique({
    where: { id: input.workItemId },
    include: {
      expert: true,
      project: true,
      assignment: true,
      paymentItem: true,
      reviews: { where: { state: 'APPROVED' }, orderBy: { decidedAt: 'desc' }, take: 1 },
      submissions: { orderBy: { revision: 'desc' }, take: 1 },
    },
  });
  if (!workItem) throw notFound('Work item not found.');

  if (workItem.status !== 'APPROVED') {
    throw invalidState(
      `Work item ${workItem.reference} is ${workItem.status}. Only approved work becomes a payment item.`,
    );
  }

  const review = workItem.reviews[0];
  if (!review) throw invalidState('Approved work item has no approving review recorded.');

  // Idempotency: the unique index on workReviewId is the real guarantee, this
  // is the fast path.
  if (workItem.paymentItem) {
    return {
      item: workItem.paymentItem,
      created: false,
      discrepancies: (workItem.paymentItem.discrepancies as unknown as Discrepancy[]) ?? [],
    };
  }

  const quantityScaled = toQuantityScaled(review.approvedQuantity?.toString() ?? '0');
  if (quantityScaled <= 0) {
    throw invalidState('The approving review did not authorise a quantity greater than zero.');
  }

  // The agreed rate is the one on the assignment, not the expert's list rate.
  const rateMinor = workItem.assignment.rateCents;
  const currency = workItem.assignment.currency;
  const amountMinor = computeAmountMinor(quantityScaled, rateMinor);

  const discrepancies = detectDiscrepancies({
    basis: workItem.basis,
    quantityScaled,
    claimedQuantity: workItem.submissions[0]?.hoursClaimed?.toString() ?? null,
    rateMinor,
    expertListRateCents: workItem.expert.hourlyRateCents,
    projectCeilingCents: workItem.project.maxHourlyRateCents,
  });

  try {
    const item = await db.paymentItem.create({
      data: {
        reference: await nextItemReference(db),
        expertId: workItem.expertId,
        projectId: workItem.projectId,
        workItemId: workItem.id,
        workReviewId: review.id,
        basis: workItem.basis,
        quantity: quantityToString(quantityScaled),
        rateMinor,
        currency,
        amountMinor,
        status: discrepancies.length > 0 ? 'DRAFT' : 'READY',
        discrepancies: discrepancies as unknown as Prisma.InputJsonValue,
      },
    });

    await recordActivity(db, {
      actor,
      entityType: 'payment_item',
      entityId: item.id,
      projectId: workItem.projectId,
      expertId: workItem.expertId,
      action: 'payment.drafted',
      summary: `Draft payment ${item.reference} prepared for ${workItem.expert.fullName} (${workItem.reference})`,
      metadata: {
        amountMinor,
        currency,
        quantity: quantityToString(quantityScaled),
        rateMinor,
        discrepancies: discrepancies.length,
        automated: actor.type === 'SYSTEM',
      },
    });

    return { item, created: true, discrepancies };
  } catch (error) {
    if (isPrismaErrorCode(error, PG_UNIQUE_VIOLATION)) {
      // Another worker drafted it first. Return theirs.
      const existing = await db.paymentItem.findUnique({ where: { workReviewId: review.id } });
      if (existing) {
        return {
          item: existing,
          created: false,
          discrepancies: (existing.discrepancies as unknown as Discrepancy[]) ?? [],
        };
      }
    }
    throw error;
  }
}

/**
 * Machine checks that need a human to look.
 *
 * These never block drafting; they mark the item so it cannot reach an export
 * without someone explaining the difference.
 */
export function detectDiscrepancies(input: {
  basis: string;
  quantityScaled: number;
  claimedQuantity: string | null;
  rateMinor: number;
  expertListRateCents: number;
  projectCeilingCents: number | null;
}): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  if (input.claimedQuantity !== null) {
    const claimedScaled = toQuantityScaled(input.claimedQuantity);
    if (claimedScaled !== input.quantityScaled) {
      discrepancies.push({
        code: 'QUANTITY_ADJUSTED',
        message: `Expert claimed ${quantityToString(claimedScaled)} but the reviewer approved ${quantityToString(input.quantityScaled)}.`,
      });
    }
  }

  if (input.projectCeilingCents !== null && input.rateMinor > input.projectCeilingCents) {
    discrepancies.push({
      code: 'RATE_ABOVE_CEILING',
      message: `Agreed rate ${minorToPlainDecimal(input.rateMinor)} is above the project ceiling ${minorToPlainDecimal(input.projectCeilingCents)}.`,
    });
  }

  if (input.rateMinor !== input.expertListRateCents) {
    discrepancies.push({
      code: 'RATE_DIFFERS_FROM_PROFILE',
      message: `Assignment rate ${minorToPlainDecimal(input.rateMinor)} differs from the expert's profile rate ${minorToPlainDecimal(input.expertListRateCents)}.`,
    });
  }

  if (input.basis === 'HOURLY' && input.quantityScaled > 60_00) {
    discrepancies.push({
      code: 'UNUSUALLY_HIGH_HOURS',
      message: `${quantityToString(input.quantityScaled)} hours on a single item is unusually high.`,
    });
  }

  return discrepancies;
}

/** HUMAN DECISION. Clear a flagged discrepancy with an explanation on the record. */
export async function resolveDiscrepancy(
  db: Db,
  actor: Actor,
  input: { paymentItemId: string; resolution: string },
): Promise<PaymentItem> {
  if (!input.resolution.trim()) {
    throw badRequest('An explanation is required to clear a payment discrepancy.');
  }

  const item = await db.paymentItem.findUnique({
    where: { id: input.paymentItemId },
    include: { expert: true },
  });
  if (!item) throw notFound('Payment item not found.');
  if (item.status === 'EXPORTED') {
    throw invalidState('This item was already exported. Raise a correction instead.');
  }
  const flags = (item.discrepancies as unknown as Discrepancy[]) ?? [];
  if (flags.length === 0) throw invalidState('This payment item has no open discrepancies.');

  const updated = await db.paymentItem.update({
    where: { id: input.paymentItemId },
    data: {
      status: item.status === 'DRAFT' ? 'READY' : item.status,
      discrepancyResolvedById: actor.userId ?? null,
      discrepancyResolvedAt: clockNow(),
      discrepancyResolution: input.resolution.trim(),
    },
  });

  await recordActivity(db, {
    actor,
    entityType: 'payment_item',
    entityId: item.id,
    projectId: item.projectId,
    expertId: item.expertId,
    action: 'payment.discrepancy_resolved',
    summary: `${actor.label} cleared ${flags.length} discrepancy flag(s) on ${item.reference}`,
    metadata: { resolution: input.resolution.trim(), flags: flags.map((f) => f.code) },
  });

  return updated;
}

/**
 * Correct an item by superseding it.
 *
 * The original is voided and kept; the replacement carries the new figures. Any
 * batch approval that covered the original figure is invalidated, because the
 * approver approved a number that is no longer the number.
 */
export async function correctPaymentItem(
  client: Transactor,
  actor: Actor,
  input: { paymentItemId: string; quantity: string | number; reason: string },
): Promise<{ voided: PaymentItem; replacement: PaymentItem; invalidatedBatchId: string | null }> {
  if (!input.reason.trim()) throw badRequest('A reason is required for a correction.');

  return client.$transaction(async (tx) => {
    const original = await tx.paymentItem.findUnique({
      where: { id: input.paymentItemId },
      include: { batch: true, expert: true },
    });
    if (!original) throw notFound('Payment item not found.');
    if (original.status === 'VOID') throw invalidState('This item was already voided.');
    if (original.supersededById) throw invalidState('This item has already been corrected.');

    const quantityScaled = toQuantityScaled(input.quantity);
    if (quantityScaled <= 0) throw badRequest('Corrected quantity must be greater than zero.');

    const amountMinor = computeAmountMinor(quantityScaled, original.rateMinor);

    const replacement = await tx.paymentItem.create({
      data: {
        reference: await nextItemReference(tx),
        expertId: original.expertId,
        projectId: original.projectId,
        // The work links stay on the original so the unique constraints hold.
        basis: original.basis,
        quantity: quantityToString(quantityScaled),
        rateMinor: original.rateMinor,
        currency: original.currency,
        amountMinor,
        status: 'READY',
        notes: `Correction of ${original.reference}: ${input.reason.trim()}`,
        discrepancies: [
          {
            code: 'CORRECTION',
            message: `Replaces ${original.reference} (${minorToPlainDecimal(original.amountMinor)}).`,
          },
        ] as unknown as Prisma.InputJsonValue,
      },
    });

    await tx.paymentItem.update({
      where: { id: original.id },
      data: {
        status: 'VOID',
        voidedAt: clockNow(),
        voidReason: input.reason.trim(),
        supersededById: replacement.id,
        batchId: null,
      },
    });

    // An approved or pending batch containing the original no longer reflects
    // what an approver signed off, so approval is withdrawn.
    let invalidatedBatchId: string | null = null;
    if (original.batchId && original.batch) {
      if (original.batch.status === 'APPROVED' || original.batch.status === 'PENDING_APPROVAL') {
        await tx.paymentBatch.update({
          where: { id: original.batchId },
          data: {
            status: 'DRAFT',
            approvedById: null,
            approvedAt: null,
            note: `${original.batch.note}\n[re-approval needed] ${original.reference} was corrected.`.trim(),
          },
        });
        invalidatedBatchId = original.batchId;
      }
      await recomputeBatchTotals(tx, original.batchId);
    }

    await recordActivity(tx, {
      actor,
      entityType: 'payment_item',
      entityId: replacement.id,
      projectId: original.projectId,
      expertId: original.expertId,
      action: 'payment.corrected',
      summary: `${actor.label} corrected ${original.reference}; ${replacement.reference} replaces it`,
      metadata: {
        reason: input.reason.trim(),
        previousAmountMinor: original.amountMinor,
        newAmountMinor: amountMinor,
        invalidatedBatchId,
      },
    });

    return {
      voided: await tx.paymentItem.findUniqueOrThrow({ where: { id: original.id } }),
      replacement,
      invalidatedBatchId,
    };
  });
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

const BATCH_TRANSITIONS: Record<PaymentBatchStatus, PaymentBatchStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['EXPORTED', 'DRAFT', 'CANCELLED'],
  EXPORTED: [],
  CANCELLED: [],
};

function assertBatchTransition(from: PaymentBatchStatus, to: PaymentBatchStatus) {
  const allowed = BATCH_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw invalidState(
      `Payment batch cannot move from ${from} to ${to}. Allowed: ${allowed.join(', ') || 'none'}.`,
      { from, to, allowed },
    );
  }
}

/** Statuses in which a batch still holds a claim on its items. */
const ACTIVE_BATCH_STATUSES: PaymentBatchStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'EXPORTED',
];

export async function createBatch(
  client: Transactor,
  actor: Actor,
  input: {
    periodStart: Date;
    periodEnd: Date;
    currency?: string;
    note?: string;
    itemIds: string[];
  },
): Promise<PaymentBatch> {
  if (input.itemIds.length === 0) throw badRequest('A payment batch needs at least one item.');
  if (input.periodEnd < input.periodStart) {
    throw badRequest('Batch period end cannot be before the start.');
  }

  return client.$transaction(async (tx) => {
    const items = await tx.paymentItem.findMany({
      where: { id: { in: input.itemIds } },
      include: { batch: true },
    });
    if (items.length !== input.itemIds.length) {
      throw notFound('One or more payment items could not be found.');
    }

    const currency = input.currency ?? items[0]!.currency;

    for (const item of items) {
      if (item.status === 'VOID') {
        throw invalidState(`${item.reference} is void and cannot be batched.`);
      }
      if (item.status === 'DRAFT') {
        throw invalidState(
          `${item.reference} has unresolved discrepancies. Clear them before batching.`,
          { paymentItemId: item.id },
        );
      }
      // The rule that stops the same approved work being paid twice.
      if (item.batchId && item.batch && ACTIVE_BATCH_STATUSES.includes(item.batch.status)) {
        throw conflict(
          `${item.reference} is already in batch ${item.batch.reference} (${item.batch.status}).`,
          { paymentItemId: item.id, batchId: item.batchId },
        );
      }
      if (item.currency !== currency) {
        throw badRequest(
          `Batch currency is ${currency} but ${item.reference} is ${item.currency}. Build one batch per currency.`,
        );
      }
    }

    const totalMinor = sumMinor(items.map((item) => item.amountMinor));

    const batch = await tx.paymentBatch.create({
      data: {
        reference: await nextBatchReference(tx),
        status: 'DRAFT',
        currency,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        totalMinor,
        itemCount: items.length,
        note: input.note?.trim() ?? '',
        createdById: actor.userId ?? null,
      },
    });

    await tx.paymentItem.updateMany({
      where: { id: { in: input.itemIds } },
      data: { batchId: batch.id, status: 'IN_BATCH' },
    });

    await recordActivity(tx, {
      actor,
      entityType: 'payment_batch',
      entityId: batch.id,
      action: 'payment.batch_created',
      summary: `${actor.label} created payment batch ${batch.reference} with ${items.length} item(s), total ${minorToPlainDecimal(totalMinor)} ${currency}`,
      metadata: { itemCount: items.length, totalMinor, currency },
    });

    return batch;
  });
}

async function recomputeBatchTotals(db: Db, batchId: string) {
  const items = await db.paymentItem.findMany({
    where: { batchId, status: { not: 'VOID' } },
  });
  await db.paymentBatch.update({
    where: { id: batchId },
    data: {
      totalMinor: sumMinor(items.map((item) => item.amountMinor)),
      itemCount: items.length,
    },
  });
}

export async function submitBatchForApproval(db: Db, actor: Actor, batchId: string) {
  const batch = await db.paymentBatch.findUnique({
    where: { id: batchId },
    include: { items: true },
  });
  if (!batch) throw notFound('Payment batch not found.');
  assertBatchTransition(batch.status, 'PENDING_APPROVAL');

  const unresolved = batch.items.filter((item) => {
    const flags = (item.discrepancies as unknown as Discrepancy[]) ?? [];
    return flags.length > 0 && !item.discrepancyResolvedAt;
  });
  if (unresolved.length > 0) {
    throw invalidState(
      `${unresolved.length} item(s) still have unresolved discrepancies: ${unresolved.map((i) => i.reference).join(', ')}.`,
    );
  }

  const updated = await db.paymentBatch.update({
    where: { id: batchId },
    data: { status: 'PENDING_APPROVAL' },
  });

  await recordActivity(db, {
    actor,
    entityType: 'payment_batch',
    entityId: batchId,
    action: 'payment.batch_submitted',
    summary: `${actor.label} submitted batch ${batch.reference} for approval`,
    metadata: { itemCount: batch.itemCount, totalMinor: batch.totalMinor },
  });
  return updated;
}

/**
 * HUMAN DECISION. Approve a payment batch.
 *
 * The approver cannot be the person who assembled it, which is a basic
 * separation of duties for anything that becomes money elsewhere.
 */
export async function approveBatch(
  db: Db,
  actor: Actor,
  input: { batchId: string; note?: string },
): Promise<PaymentBatch> {
  const batch = await db.paymentBatch.findUnique({
    where: { id: input.batchId },
    include: { items: true },
  });
  if (!batch) throw notFound('Payment batch not found.');
  assertBatchTransition(batch.status, 'APPROVED');

  if (batch.createdById && batch.createdById === actor.userId) {
    throw forbidden(
      'A payment batch must be approved by someone other than the operator who created it.',
    );
  }

  const at = clockNow();
  const claimed = await db.paymentBatch.updateMany({
    where: { id: input.batchId, status: 'PENDING_APPROVAL' },
    data: {
      status: 'APPROVED',
      approvedById: actor.userId ?? null,
      approvedAt: at,
      note: input.note?.trim() ?? batch.note,
    },
  });
  if (claimed.count === 0) throw invalidState('This batch was already decided by someone else.');

  await recordActivity(db, {
    actor,
    entityType: 'payment_batch',
    entityId: input.batchId,
    action: 'payment.batch_approved',
    summary: `${actor.label} approved batch ${batch.reference}: ${batch.itemCount} item(s), ${minorToPlainDecimal(batch.totalMinor)} ${batch.currency}`,
    metadata: { totalMinor: batch.totalMinor, itemCount: batch.itemCount },
  });

  return db.paymentBatch.findUniqueOrThrow({ where: { id: input.batchId } });
}

export interface ExportResult {
  batch: PaymentBatch;
  csv: string;
  filename: string;
}

/**
 * Export an approved batch.
 *
 * Marks the batch and its items EXPORTED. That records that a file left this
 * system; it is **not** a record that anyone was paid. There is no action in
 * this application that claims otherwise.
 */
export async function exportBatch(db: Db, actor: Actor, batchId: string): Promise<ExportResult> {
  const batch = await db.paymentBatch.findUnique({
    where: { id: batchId },
    include: {
      items: {
        where: { status: { not: 'VOID' } },
        include: {
          expert: { select: { reference: true, fullName: true, email: true } },
          project: { select: { code: true, title: true } },
          workItem: { select: { reference: true, title: true } },
        },
        orderBy: { reference: 'asc' },
      },
    },
  });
  if (!batch) throw notFound('Payment batch not found.');

  if (batch.status !== 'APPROVED') {
    throw invalidState(
      `Batch ${batch.reference} is ${batch.status}. Only an APPROVED batch can be exported, and approval is a human decision.`,
      { status: batch.status },
    );
  }

  const csv = toCsv(
    [
      'payment_reference',
      'expert_reference',
      'expert_name',
      'expert_email',
      'project_code',
      'work_reference',
      'work_title',
      'basis',
      'quantity',
      'rate',
      'currency',
      'amount',
      'discrepancy_resolution',
      'notes',
    ],
    batch.items.map((item) => [
      item.reference,
      item.expert.reference,
      item.expert.fullName,
      item.expert.email,
      item.project.code,
      item.workItem?.reference ?? '',
      item.workItem?.title ?? '',
      item.basis,
      item.quantity.toString(),
      minorToPlainDecimal(item.rateMinor),
      item.currency,
      minorToPlainDecimal(item.amountMinor),
      item.discrepancyResolution ?? '',
      item.notes,
    ]),
  );

  const at = clockNow();
  const claimed = await db.paymentBatch.updateMany({
    where: { id: batchId, status: 'APPROVED' },
    data: { status: 'EXPORTED', exportedAt: at, exportedById: actor.userId ?? null },
  });
  if (claimed.count === 0) throw invalidState('This batch was already exported.');

  await db.paymentItem.updateMany({
    where: { batchId, status: 'IN_BATCH' },
    data: { status: 'EXPORTED' },
  });

  await recordActivity(db, {
    actor,
    entityType: 'payment_batch',
    entityId: batchId,
    action: 'payment.batch_exported',
    summary: `${actor.label} exported batch ${batch.reference} (${batch.items.length} item(s), ${minorToPlainDecimal(batch.totalMinor)} ${batch.currency})`,
    metadata: {
      itemCount: batch.items.length,
      totalMinor: batch.totalMinor,
      // Recorded explicitly: this is a file, not a settlement.
      meaning: 'exported-for-finance-not-paid',
    },
  });

  return {
    batch: await db.paymentBatch.findUniqueOrThrow({ where: { id: batchId } }),
    csv,
    filename: `expertops-${batch.reference.toLowerCase()}-${at.toISOString().slice(0, 10)}.csv`,
  };
}

export async function listPaymentItems(
  db: Db,
  query: {
    status?: PaymentItemStatus;
    expertId?: string;
    projectId?: string;
    batchId?: string;
    limit?: number;
  } = {},
) {
  const where: Prisma.PaymentItemWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.expertId) where.expertId = query.expertId;
  if (query.projectId) where.projectId = query.projectId;
  if (query.batchId) where.batchId = query.batchId;

  return db.paymentItem.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }],
    take: Math.min(query.limit ?? 100, 300),
    include: {
      expert: { select: { id: true, reference: true, fullName: true } },
      project: { select: { id: true, code: true, title: true } },
      workItem: { select: { id: true, reference: true, title: true } },
      batch: { select: { id: true, reference: true, status: true } },
    },
  });
}

export async function listBatches(
  db: Db,
  query: { status?: PaymentBatchStatus; limit?: number } = {},
) {
  return db.paymentBatch.findMany({
    where: query.status ? { status: query.status } : {},
    orderBy: { createdAt: 'desc' },
    take: Math.min(query.limit ?? 50, 200),
    include: {
      createdBy: { select: { id: true, name: true } },
      approvedBy: { select: { id: true, name: true } },
      _count: { select: { items: true } },
    },
  });
}

export async function getBatch(db: Db, batchId: string) {
  const batch = await db.paymentBatch.findUnique({
    where: { id: batchId },
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      approvedBy: { select: { id: true, name: true, email: true } },
      items: {
        orderBy: { reference: 'asc' },
        include: {
          expert: { select: { id: true, reference: true, fullName: true } },
          project: { select: { id: true, code: true } },
          workItem: { select: { id: true, reference: true, title: true } },
        },
      },
    },
  });
  if (!batch) throw notFound('Payment batch not found.');
  return batch;
}

export async function paymentCounts(db: Db) {
  const grouped = await db.paymentItem.groupBy({
    by: ['status'],
    _count: { _all: true },
    _sum: { amountMinor: true },
  });
  const counts: Record<string, { count: number; totalMinor: number }> = {};
  for (const row of grouped) {
    counts[row.status] = { count: row._count._all, totalMinor: row._sum.amountMinor ?? 0 };
  }

  const withOpenDiscrepancies = await db.paymentItem.count({
    where: { status: 'DRAFT', discrepancyResolvedAt: null },
  });

  return { byStatus: counts, withOpenDiscrepancies };
}
