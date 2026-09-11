import {
  type OutreachBatch,
  type OutreachBatchKind,
  type OutreachBatchStatus,
  type Prisma,
} from '@prisma/client';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, forbidden, invalidState, notFound } from '@/lib/errors';
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
  APPROVED: ['DISPATCHED', 'CANCELLED'],
  REJECTED: ['DRAFT'],
  DISPATCHED: [],
  CANCELLED: [],
};

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
  db: Db,
  actor: Actor,
  input: CreateBatchInput,
): Promise<OutreachBatch> {
  if (input.items.length === 0) throw badRequest('A batch needs at least one recipient.');
  if (input.items.length > 100) throw badRequest('A batch is limited to 100 recipients.');

  if (input.projectId) {
    const project = await db.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw notFound('Project not found.');
  }

  const uniqueIds = new Set(input.items.map((item) => item.expertId));
  if (uniqueIds.size !== input.items.length) {
    throw badRequest('The same expert is listed twice in this batch.');
  }

  const batch = await db.outreachBatch.create({
    data: {
      reference: await nextBatchReference(db),
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

  await recordActivity(db, {
    actor,
    entityType: 'outreach_batch',
    entityId: batch.id,
    projectId: batch.projectId,
    action: 'outreach.batch_created',
    summary: `${actor.label} drafted outreach batch ${batch.reference} with ${input.items.length} recipient(s)`,
    metadata: { kind: input.kind, recipients: input.items.length, awaitingApproval: true },
  });

  return batch;
}

/** Build a replacement batch from the recommendation engine. Still needs approval. */
export async function buildReplacementBatch(
  db: Db,
  actor: Actor,
  input: { projectId: string; reason: string; limit?: number },
): Promise<{ batch: OutreachBatch | null; recommendations: number }> {
  const recommendations = await recommendReplacements(db, input.projectId, input.limit ?? 5);
  if (recommendations.length === 0) {
    return { batch: null, recommendations: 0 };
  }

  const batch = await createBatch(db, actor, {
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
  db: Db,
  actor: Actor,
  batchId: string,
): Promise<OutreachBatch> {
  const batch = await db.outreachBatch.findUnique({
    where: { id: batchId },
    include: { items: true },
  });
  if (!batch) throw notFound('Outreach batch not found.');
  assertBatchTransition(batch.status, 'PENDING_APPROVAL');
  if (batch.items.length === 0) throw invalidState('An empty batch cannot be submitted.');

  const updated = await db.outreachBatch.update({
    where: { id: batchId },
    data: { status: 'PENDING_APPROVAL' },
  });

  await recordActivity(db, {
    actor,
    entityType: 'outreach_batch',
    entityId: batchId,
    projectId: batch.projectId,
    action: 'outreach.batch_submitted',
    summary: `${actor.label} submitted batch ${batch.reference} for approval`,
    metadata: { recipients: batch.items.length },
  });
  return updated;
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
  db: Db,
  actor: Actor,
  input: ApprovalInput,
): Promise<OutreachBatch> {
  const batch = await db.outreachBatch.findUnique({
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
  const claimed = await db.outreachBatch.updateMany({
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
    db,
    `outreach:awaiting_approval:${input.batchId}`,
    input.approve ? 'The batch was approved.' : 'The batch was rejected.',
  );

  await recordActivity(db, {
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

  return db.outreachBatch.findUniqueOrThrow({ where: { id: input.batchId } });
}

export interface DispatchResult {
  batch: OutreachBatch;
  dispatched: number;
  skipped: Array<{ expertId: string; reason: string }>;
}

/**
 * AUTOMATED, but only after approval.
 *
 * Creates an invitation per recipient through the existing invitation service,
 * so every project-eligibility rule still applies. A recipient who has become
 * ineligible since the batch was assembled is skipped with the reason recorded,
 * not silently dropped.
 */
export async function dispatchBatch(
  db: Db,
  actor: Actor,
  batchId: string,
  options: { ttlHours?: number; message?: string } = {},
): Promise<DispatchResult> {
  const batch = await db.outreachBatch.findUnique({
    where: { id: batchId },
    include: { items: true, project: true },
  });
  if (!batch) throw notFound('Outreach batch not found.');

  if (batch.status !== 'APPROVED') {
    throw invalidState(
      `Batch ${batch.reference} is ${batch.status}. Only an APPROVED batch can be dispatched, and approval is a human decision.`,
      { status: batch.status },
    );
  }
  if (!batch.projectId) {
    throw invalidState(
      'This batch is not attached to a project, so invitations cannot be created.',
    );
  }

  const skipped: DispatchResult['skipped'] = [];
  let dispatched = 0;

  for (const item of batch.items) {
    if (!item.expertId) continue;
    if (item.invitationId) continue; // already dispatched by an earlier attempt

    try {
      const invitation = await createInvitation(db, actor, {
        projectId: batch.projectId,
        expertId: item.expertId,
        message: options.message ?? batch.reason,
        ttlHours: options.ttlHours,
      });
      await db.outreachBatchItem.update({
        where: { id: item.id },
        data: { invitationId: invitation.id, skippedReason: null },
      });
      dispatched += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await db.outreachBatchItem.update({
        where: { id: item.id },
        data: { skippedReason: reason },
      });
      skipped.push({ expertId: item.expertId, reason });
    }
  }

  const updated = await db.outreachBatch.update({
    where: { id: batchId },
    data: { status: 'DISPATCHED', dispatchedAt: clockNow() },
  });

  await recordActivity(db, {
    actor,
    entityType: 'outreach_batch',
    entityId: batchId,
    projectId: batch.projectId,
    action: 'outreach.batch_dispatched',
    summary: `Batch ${batch.reference} dispatched: ${dispatched} invitation(s) created, ${skipped.length} skipped`,
    metadata: { dispatched, skipped, approvedById: batch.approvedById, simulated: true },
  });

  return { batch: updated, dispatched, skipped };
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
