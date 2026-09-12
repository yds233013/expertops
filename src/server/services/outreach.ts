import {
  type OutreachBatch,
  type OutreachBatchKind,
  type OutreachBatchStatus,
  type Prisma,
} from '@prisma/client';
import { type Db, type MaybeTransactor, withTransaction } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, forbidden, invalidState, isAppError, notFound } from '@/lib/errors';
import { formatReference, parseReferenceSequence } from '@/lib/ids';
import { type Actor, recordActivity } from './activity';
import { resolveIfPresent } from './attention';
import { createInvitation } from './invitations';
import { recommendReplacements } from './staffing-gaps';

/**
 * Outreach batches.
 *
 * The system can assemble a list of people worth contacting. It can never
 * contact them. A batch sits in PENDING_APPROVAL until an authorised operator
 * approves it, and only then does dispatch create invitations.
 *
 * This is the boundary that keeps bulk outreach a human decision: assembling a
 * list is cheap and automatic, sending it is neither.
 *
 * ## Atomicity
 *
 * Each operation here changes business state, writes the activity event that
 * explains it, and sometimes enqueues follow-up work. Those belong together: a
 * status that moved without its audit entry is a batch nobody can account for,
 * and an approval recorded without the job that acts on it is an approval that
 * never happens. Every one of these functions therefore takes a `Transactor`
 * and does its writes inside a single transaction.
 *
 * Dispatch is the exception, and deliberately so. One transaction for a hundred
 * invitations would mean one failure discards ninety-nine successes, so each
 * recipient commits on its own and the batch records how far it got.
 */
export const BATCH_REFERENCE_PREFIX = 'BAT';

async function nextBatchReference(db: Db): Promise<string> {
  // Only well-formed references count towards the sequence; see
  // nextExpertReference for why lexical MAX is unsafe here.
  const rows = await db.outreachBatch.findMany({
    where: { reference: { startsWith: `${BATCH_REFERENCE_PREFIX}-` } },
    select: { reference: true },
  });

  let highest = 0;
  for (const row of rows) {
    const sequence = parseReferenceSequence(BATCH_REFERENCE_PREFIX, row.reference);
    if (sequence > highest) highest = sequence;
  }
  return formatReference(BATCH_REFERENCE_PREFIX, highest + 1);
}

const BATCH_TRANSITIONS: Record<OutreachBatchStatus, OutreachBatchStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['PARTIALLY_DISPATCHED', 'DISPATCHED', 'CANCELLED'],
  REJECTED: ['DRAFT'],
  // A partially dispatched batch can be dispatched again: the retryable
  // recipients are picked up and the ones already sent are left alone.
  PARTIALLY_DISPATCHED: ['PARTIALLY_DISPATCHED', 'DISPATCHED', 'CANCELLED'],
  // Self-transition only, so a repeated dispatch request is a harmless no-op
  // rather than an error. Nothing is outstanding, so nothing happens.
  DISPATCHED: ['DISPATCHED'],
  CANCELLED: [],
};

/**
 * Statuses from which dispatch may run.
 *
 * DISPATCHED is included on purpose: a repeated request must be safe, and a
 * finished batch has nothing left to act on, so the call does nothing and says
 * so rather than failing.
 */
export const DISPATCHABLE_STATUSES: OutreachBatchStatus[] = [
  'APPROVED',
  'PARTIALLY_DISPATCHED',
  'DISPATCHED',
];

export interface BatchItemInput {
  expertId: string;
  rationale?: string;
  matchScore?: number | null;
}

export interface CreateBatchInput {
  kind: OutreachBatchKind;
  projectId?: string | null;
  reason?: string;
  note?: string;
  items: BatchItemInput[];
}

export async function createBatch(
  client: MaybeTransactor,
  actor: Actor,
  input: CreateBatchInput,
): Promise<OutreachBatch> {
  if (input.items.length === 0) throw badRequest('A batch needs at least one recipient.');
  if (input.items.length > 100) throw badRequest('A batch is limited to 100 recipients.');

  const uniqueIds = new Set(input.items.map((item) => item.expertId));
  if (uniqueIds.size !== input.items.length) {
    throw badRequest('The same expert is listed twice in this batch.');
  }

  // The batch and the activity entry that explains it are written together.
  return withTransaction(client, async (tx) => {
    if (input.projectId) {
      const project = await tx.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw notFound('Project not found.');
    }

    const batch = await tx.outreachBatch.create({
      data: {
        reference: await nextBatchReference(tx),
        kind: input.kind,
        status: 'DRAFT',
        projectId: input.projectId ?? null,
        reason: input.reason?.trim() ?? '',
        note: input.note?.trim() ?? '',
        createdById: actor.userId ?? null,
        items: {
          create: input.items.map((item) => ({
            expertId: item.expertId,
            rationale: item.rationale?.trim() ?? '',
            matchScore: item.matchScore ?? null,
          })),
        },
      },
    });

    await recordActivity(tx, {
      actor,
      entityType: 'outreach_batch',
      entityId: batch.id,
      projectId: batch.projectId,
      action: 'outreach.batch_created',
      summary: `${actor.label} drafted outreach batch ${batch.reference} with ${input.items.length} recipient(s)`,
      metadata: { kind: input.kind, recipients: input.items.length, awaitingApproval: true },
    });

    return batch;
  });
}

/** Build a replacement batch from the recommendation engine. Still needs approval. */
export async function buildReplacementBatch(
  client: MaybeTransactor,
  actor: Actor,
  input: { projectId: string; reason: string; limit?: number },
): Promise<{ batch: OutreachBatch | null; recommendations: number }> {
  const recommendations = await recommendReplacements(client, input.projectId, input.limit ?? 5);
  if (recommendations.length === 0) {
    return { batch: null, recommendations: 0 };
  }

  const batch = await createBatch(client, actor, {
    kind: 'REPLACEMENT',
    projectId: input.projectId,
    reason: input.reason,
    items: recommendations.map((recommendation) => ({
      expertId: recommendation.expertId,
      rationale: recommendation.rationale,
      matchScore: recommendation.score,
    })),
  });

  return { batch, recommendations: recommendations.length };
}

export async function submitBatchForApproval(
  client: MaybeTransactor,
  actor: Actor,
  batchId: string,
): Promise<OutreachBatch> {
  return withTransaction(client, async (tx) => {
    const batch = await tx.outreachBatch.findUnique({
      where: { id: batchId },
      include: { items: true },
    });
    if (!batch) throw notFound('Outreach batch not found.');
    assertBatchTransition(batch.status, 'PENDING_APPROVAL');
    if (batch.items.length === 0) throw invalidState('An empty batch cannot be submitted.');

    // Conditional on the status we checked, so two submits cannot both win.
    const claimed = await tx.outreachBatch.updateMany({
      where: { id: batchId, status: batch.status },
      data: { status: 'PENDING_APPROVAL' },
    });
    if (claimed.count === 0) {
      throw invalidState('This batch was changed by someone else. Reload and try again.');
    }

    await recordActivity(tx, {
      actor,
      entityType: 'outreach_batch',
      entityId: batchId,
      projectId: batch.projectId,
      action: 'outreach.batch_submitted',
      summary: `${actor.label} submitted batch ${batch.reference} for approval`,
      metadata: { recipients: batch.items.length },
    });
    return tx.outreachBatch.findUniqueOrThrow({ where: { id: batchId } });
  });
}

function assertBatchTransition(from: OutreachBatchStatus, to: OutreachBatchStatus) {
  const allowed = BATCH_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw invalidState(
      `Outreach batch cannot move from ${from} to ${to}. Allowed: ${allowed.join(', ') || 'none'}.`,
      { from, to, allowed },
    );
  }
}

export interface ApprovalInput {
  batchId: string;
  approve: boolean;
  note?: string;
}

/**
 * HUMAN DECISION. Approve or reject a batch.
 *
 * Approval is recorded against the operator who gave it, and the person who
 * created the batch cannot be the one who approves it when the batch is large
 * enough to matter.
 */
export const SELF_APPROVAL_LIMIT = 5;

export async function decideBatch(
  client: MaybeTransactor,
  actor: Actor,
  input: ApprovalInput,
): Promise<OutreachBatch> {
  return withTransaction(client, async (tx) => {
    const batch = await tx.outreachBatch.findUnique({
      where: { id: input.batchId },
      include: { items: true, project: true },
    });
    if (!batch) throw notFound('Outreach batch not found.');
    assertBatchTransition(batch.status, input.approve ? 'APPROVED' : 'REJECTED');

    if (!input.approve && !input.note?.trim()) {
      throw badRequest('A reason is required when rejecting a batch.');
    }
    if (
      input.approve &&
      batch.createdById &&
      batch.createdById === actor.userId &&
      batch.items.length > SELF_APPROVAL_LIMIT
    ) {
      throw forbidden(
        `A batch of ${batch.items.length} recipients needs a second operator to approve it. You created this one.`,
      );
    }

    const at = clockNow();
    const claimed = await tx.outreachBatch.updateMany({
      where: { id: input.batchId, status: 'PENDING_APPROVAL' },
      data: input.approve
        ? {
            status: 'APPROVED',
            approvedById: actor.userId ?? null,
            approvedAt: at,
            note: input.note?.trim() ?? batch.note,
          }
        : {
            status: 'REJECTED',
            rejectedById: actor.userId ?? null,
            rejectedAt: at,
            note: input.note!.trim(),
          },
    });
    if (claimed.count === 0) {
      throw invalidState('This batch was already decided by someone else.');
    }

    await resolveIfPresent(
      tx,
      `outreach:awaiting_approval:${input.batchId}`,
      input.approve ? 'The batch was approved.' : 'The batch was rejected.',
    );

    await recordActivity(tx, {
      actor,
      entityType: 'outreach_batch',
      entityId: input.batchId,
      projectId: batch.projectId,
      action: input.approve ? 'outreach.batch_approved' : 'outreach.batch_rejected',
      summary: input.approve
        ? `${actor.label} approved batch ${batch.reference} (${batch.items.length} recipients)`
        : `${actor.label} rejected batch ${batch.reference}`,
      metadata: { recipients: batch.items.length, note: input.note?.trim() ?? null },
    });

    return tx.outreachBatch.findUniqueOrThrow({ where: { id: input.batchId } });
  });
}

export interface DispatchResult {
  batch: OutreachBatch;
  /** Invitations this request committed. Work another request did is not counted. */
  dispatched: number;
  /** Recipients this request permanently excluded, by a business rule. */
  skipped: Array<{ expertId: string; reason: string }>;
  /** Recipients this request left retryable, after an infrastructure fault. */
  failed: Array<{ expertId: string; error: string }>;
  /** Outstanding recipients another overlapping request settled first. */
  takenByAnotherRequest: number;
  /** Authoritative totals, read back from the database after the loop. */
  totals: { sent: number; skipped: number; failed: number; pending: number };
  /** Recipients already sent before this request started. */
  alreadySent: number;
  complete: boolean;
}

/** What happened to one recipient in this request. */
type RecipientOutcome =
  | { kind: 'sent' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; error: string }
  /** Another request settled this recipient; this one did nothing to it. */
  | { kind: 'taken' };

/**
 * Record a failed attempt without trampling a recipient somebody else settled.
 *
 * Compare-and-set on the state we believed the row was in. Two overlapping
 * requests can both pass the claim, roll back, and arrive here; without the
 * condition, the slower one's verdict would overwrite the faster one's success
 * and a recipient who *was* invited would be left reading FAILED with no
 * invitation. Exported so the guard can be tested directly rather than only
 * through a race.
 */
export async function recordDispatchFailure(
  db: Db,
  itemId: string,
  error: unknown,
): Promise<'skipped' | 'failed' | 'taken'> {
  const message = error instanceof Error ? error.message : String(error);
  // An AppError is the domain saying no, which will not change on a retry.
  // Anything else is the machinery failing, which says nothing about this
  // person's eligibility.
  const permanent = isAppError(error);

  const updated = await db.outreachBatchItem.updateMany({
    where: { id: itemId, dispatchState: { in: ['PENDING', 'FAILED'] } },
    data: permanent
      ? {
          dispatchState: 'SKIPPED',
          skippedReason: message,
          lastError: null,
          attempts: { increment: 1 },
        }
      : {
          dispatchState: 'FAILED',
          lastError: message.slice(0, 1000),
          attempts: { increment: 1 },
        },
  });

  if (updated.count === 0) return 'taken';
  return permanent ? 'skipped' : 'failed';
}

/**
 * AUTOMATED, but only after approval.
 *
 * Creates an invitation per recipient through the existing invitation service,
 * so every project-eligibility rule still applies and there is no second
 * invitation implementation to keep in step.
 *
 * Each recipient commits in its own transaction — the invitation, its activity
 * entry and the item's new state together. One transaction for a hundred
 * invitations would mean one failure discarding ninety-nine successes.
 *
 * Two overlapping dispatch requests are safe, and the counts stay honest:
 *
 *  * The per-recipient claim is a conditional update inside the transaction, so
 *    the row is locked for the duration. A second request either claims it
 *    first or finds it settled and reports `takenByAnotherRequest` — it does
 *    not count work it did not do.
 *  * Failure recording is a compare-and-set, so a request that rolled back
 *    cannot overwrite a recipient another request has since marked SENT.
 *  * The batch's final status and the totals returned come from reading the
 *    recipient rows back, not from this request's own tally.
 *
 * Calling dispatch again is safe: SENT and SKIPPED rows are never reconsidered,
 * so no recipient is invited twice.
 */
export async function dispatchBatch(
  client: MaybeTransactor,
  actor: Actor,
  batchId: string,
  options: { ttlHours?: number; message?: string } = {},
): Promise<DispatchResult> {
  const batch = await client.outreachBatch.findUnique({
    where: { id: batchId },
    include: { items: true, project: true },
  });
  if (!batch) throw notFound('Outreach batch not found.');

  if (!DISPATCHABLE_STATUSES.includes(batch.status)) {
    throw invalidState(
      `Batch ${batch.reference} is ${batch.status}. Only an approved batch can be dispatched, and approval is a human decision.`,
      { status: batch.status },
    );
  }
  if (!batch.projectId) {
    throw invalidState(
      'This batch is not attached to a project, so invitations cannot be created.',
    );
  }
  const projectId = batch.projectId;

  const skipped: DispatchResult['skipped'] = [];
  const failed: DispatchResult['failed'] = [];
  let dispatched = 0;
  let takenByAnotherRequest = 0;
  const alreadySent = batch.items.filter((item) => item.dispatchState === 'SENT').length;

  // Only work that is outstanding. SENT and SKIPPED are settled.
  const outstanding = batch.items.filter(
    (item) =>
      item.expertId && (item.dispatchState === 'PENDING' || item.dispatchState === 'FAILED'),
  );

  for (const item of outstanding) {
    const expertId = item.expertId!;
    let outcome: RecipientOutcome;

    try {
      outcome = await withTransaction(client, async (tx): Promise<RecipientOutcome> => {
        // Claim under the transaction, which locks the row for its duration. A
        // concurrent request blocks here and then re-evaluates the condition,
        // so exactly one of them proceeds.
        const claimed = await tx.outreachBatchItem.updateMany({
          where: { id: item.id, dispatchState: { in: ['PENDING', 'FAILED'] } },
          data: { dispatchedAt: null },
        });
        if (claimed.count === 0) return { kind: 'taken' };

        const invitation = await createInvitation(tx, actor, {
          projectId,
          expertId,
          message: options.message ?? batch.reason,
          ttlHours: options.ttlHours,
        });
        await tx.outreachBatchItem.update({
          where: { id: item.id },
          data: {
            invitationId: invitation.id,
            dispatchState: 'SENT',
            dispatchedAt: clockNow(),
            attempts: { increment: 1 },
            skippedReason: null,
            lastError: null,
          },
        });
        return { kind: 'sent' };
      });
    } catch (error) {
      // Recorded outside the rolled-back transaction so the verdict and the
      // attempt count survive, and conditionally so it cannot overwrite a
      // recipient another request settled while this one was failing.
      const recorded = await recordDispatchFailure(client, item.id, error);
      const message = error instanceof Error ? error.message : String(error);
      outcome =
        recorded === 'taken'
          ? { kind: 'taken' }
          : recorded === 'skipped'
            ? { kind: 'skipped', reason: message }
            : { kind: 'failed', error: message };
    }

    if (outcome.kind === 'sent') dispatched += 1;
    else if (outcome.kind === 'skipped') skipped.push({ expertId, reason: outcome.reason });
    else if (outcome.kind === 'failed') failed.push({ expertId, error: outcome.error });
    else takenByAnotherRequest += 1;
  }

  // Authoritative: the batch's state follows the recipient rows as they now
  // stand, not this request's tally of what it happened to see.
  const totals = await recipientTotals(client, batchId);
  const complete = totals.pending === 0 && totals.failed === 0;
  const finalStatus: OutreachBatchStatus = complete ? 'DISPATCHED' : 'PARTIALLY_DISPATCHED';

  const updated = await withTransaction(client, async (tx) => {
    const current = await tx.outreachBatch.findUniqueOrThrow({ where: { id: batchId } });
    // Another request may have finished the batch already; that is not an error.
    if (current.status === finalStatus) return current;
    assertBatchTransition(current.status, finalStatus);

    const row = await tx.outreachBatch.update({
      where: { id: batchId },
      data: {
        status: finalStatus,
        dispatchedAt: complete ? (current.dispatchedAt ?? clockNow()) : current.dispatchedAt,
      },
    });

    await recordActivity(tx, {
      actor,
      entityType: 'outreach_batch',
      entityId: batchId,
      projectId,
      action: complete ? 'outreach.batch_dispatched' : 'outreach.batch_partially_dispatched',
      summary: complete
        ? `Batch ${batch.reference} dispatched: ${totals.sent} invitation(s) created, ${totals.skipped} skipped`
        : `Batch ${batch.reference} partly dispatched: ${totals.sent} sent, ${totals.skipped} skipped, ${totals.pending + totals.failed} still to retry`,
      metadata: {
        dispatchedByThisRequest: dispatched,
        takenByAnotherRequest,
        totals,
        approvedById: batch.approvedById,
        simulated: true,
      },
    });
    return row;
  });

  return {
    batch: updated,
    dispatched,
    skipped,
    failed,
    takenByAnotherRequest,
    totals,
    alreadySent,
    complete,
  };
}

/** Recipient states as the database currently holds them. */
export async function recipientTotals(db: Db, batchId: string) {
  const grouped = await db.outreachBatchItem.groupBy({
    by: ['dispatchState'],
    where: { batchId },
    _count: { _all: true },
  });
  const totals = { sent: 0, skipped: 0, failed: 0, pending: 0 };
  for (const row of grouped) {
    if (row.dispatchState === 'SENT') totals.sent = row._count._all;
    else if (row.dispatchState === 'SKIPPED') totals.skipped = row._count._all;
    else if (row.dispatchState === 'FAILED') totals.failed = row._count._all;
    else totals.pending = row._count._all;
  }
  return totals;
}

/** Recipients a repeat dispatch would act on. Used by the UI to label the button. */
export async function retryableRecipients(db: Db, batchId: string): Promise<number> {
  return db.outreachBatchItem.count({
    where: { batchId, dispatchState: { in: ['PENDING', 'FAILED'] } },
  });
}

export async function listBatches(
  db: Db,
  query: { status?: OutreachBatchStatus; projectId?: string; limit?: number } = {},
) {
  const where: Prisma.OutreachBatchWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.projectId) where.projectId = query.projectId;

  return db.outreachBatch.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(query.limit ?? 50, 200),
    include: {
      project: { select: { id: true, code: true, title: true } },
      createdBy: { select: { id: true, name: true } },
      approvedBy: { select: { id: true, name: true } },
      items: { include: { expert: { select: { id: true, reference: true, fullName: true } } } },
    },
  });
}

export async function getBatch(db: Db, batchId: string) {
  const batch = await db.outreachBatch.findUnique({
    where: { id: batchId },
    include: {
      project: true,
      createdBy: { select: { id: true, name: true, email: true } },
      approvedBy: { select: { id: true, name: true, email: true } },
      items: {
        include: {
          expert: {
            select: { id: true, reference: true, fullName: true, email: true, status: true },
          },
        },
      },
    },
  });
  if (!batch) throw notFound('Outreach batch not found.');
  return batch;
}
