import { type Prisma, type WorkBasis, type WorkItem, type WorkItemStatus } from '@prisma/client';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, invalidState, notFound } from '@/lib/errors';
import { formatReference, parseReferenceSequence } from '@/lib/ids';
import { toQuantityScaled, quantityToString } from '@/lib/decimal';
import { type Actor, recordActivity } from './activity';
import { enqueueJob } from './jobs';
import { validateWorkSampleLink } from './candidates';

/**
 * Project work items.
 *
 * Deliberately lightweight: an instruction, a due date, a submission, and a
 * human review. It is a coordination record, not a task tracker.
 *
 * One rule is load-bearing: **a review judges a submission, never a person.**
 * Nothing here writes to an expert-wide score, rating or ranking, because one
 * piece of work is not a verdict on someone's standing in the network.
 */
export const WORK_REFERENCE_PREFIX = 'WRK';

async function nextWorkReference(db: Db): Promise<string> {
  const latest = await db.workItem.findFirst({
    orderBy: { reference: 'desc' },
    select: { reference: true },
  });
  return formatReference(
    WORK_REFERENCE_PREFIX,
    parseReferenceSequence(WORK_REFERENCE_PREFIX, latest?.reference) + 1,
  );
}

const WORK_TRANSITIONS: Record<WorkItemStatus, WorkItemStatus[]> = {
  DRAFT: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['IN_REVIEW', 'REVISION_REQUESTED', 'APPROVED', 'CANCELLED'],
  IN_REVIEW: ['REVISION_REQUESTED', 'APPROVED', 'CANCELLED'],
  REVISION_REQUESTED: ['SUBMITTED', 'CANCELLED'],
  APPROVED: [],
  CANCELLED: [],
};

function assertWorkTransition(from: WorkItemStatus, to: WorkItemStatus) {
  const allowed = WORK_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw invalidState(
      `Work item cannot move from ${from} to ${to}. Allowed: ${allowed.join(', ') || 'none'}.`,
      { from, to, allowed },
    );
  }
}

export interface CreateWorkItemInput {
  assignmentId: string;
  title: string;
  instructions?: string;
  basis?: WorkBasis;
  dueAt?: Date | null;
}

export async function createWorkItem(
  db: Db,
  actor: Actor,
  input: CreateWorkItemInput,
): Promise<WorkItem> {
  if (!input.title.trim()) throw badRequest('A work item needs a title.');

  const assignment = await db.assignment.findUnique({
    where: { id: input.assignmentId },
    include: { project: true, expert: true },
  });
  if (!assignment) throw notFound('Assignment not found.');
  if (assignment.status !== 'CONFIRMED') {
    throw invalidState(
      `Work can only be assigned on a confirmed seat. This assignment is ${assignment.status}.`,
    );
  }

  const workItem = await db.workItem.create({
    data: {
      reference: await nextWorkReference(db),
      projectId: assignment.projectId,
      assignmentId: assignment.id,
      expertId: assignment.expertId,
      title: input.title.trim(),
      instructions: input.instructions?.trim() ?? '',
      basis: input.basis ?? 'DELIVERABLE',
      dueAt: input.dueAt ?? null,
      status: 'ASSIGNED',
      createdById: actor.userId ?? null,
    },
  });

  await recordActivity(db, {
    actor,
    entityType: 'work_item',
    entityId: workItem.id,
    projectId: assignment.projectId,
    expertId: assignment.expertId,
    action: 'work.assigned',
    summary: `${actor.label} assigned "${workItem.title}" (${workItem.reference}) to ${assignment.expert.fullName}`,
    metadata: { basis: workItem.basis, dueAt: input.dueAt?.toISOString() ?? null },
  });

  return workItem;
}

export interface SubmitWorkInput {
  workItemId: string;
  summary?: string;
  content: string;
  attachments?: string[];
  hoursClaimed?: string | number;
}

/** The expert submits, or resubmits after a revision request. */
export async function submitWork(db: Db, actor: Actor, input: SubmitWorkInput) {
  const workItem = await db.workItem.findUnique({
    where: { id: input.workItemId },
    include: { expert: true, project: true },
  });
  if (!workItem) throw notFound('Work item not found.');

  if (actor.type === 'EXPERT' && actor.expertId !== workItem.expertId) {
    throw notFound('Work item not found.');
  }
  assertWorkTransition(workItem.status, 'SUBMITTED');
  if (!input.content.trim()) throw badRequest('A submission needs some content.');

  const attachments = (input.attachments ?? []).slice(0, 10).map(validateWorkSampleLink);

  let hoursScaled: number | null = null;
  if (workItem.basis === 'HOURLY') {
    if (input.hoursClaimed === undefined || input.hoursClaimed === '') {
      throw badRequest('This work item is hourly, so hours worked must be supplied.');
    }
    hoursScaled = toQuantityScaled(input.hoursClaimed);
    if (hoursScaled <= 0) throw badRequest('Hours claimed must be greater than zero.');
    if (hoursScaled > 100_00) throw badRequest('Hours claimed cannot exceed 100 for one item.');
  }

  const revision = workItem.currentRevision + 1;
  const at = clockNow();

  const submission = await db.workSubmission.create({
    data: {
      workItemId: workItem.id,
      revision,
      summary: input.summary?.trim() ?? '',
      content: input.content.trim(),
      attachments: attachments as Prisma.InputJsonValue,
      hoursClaimed: hoursScaled === null ? null : quantityToString(hoursScaled),
      submittedAt: at,
    },
  });

  await db.workItem.update({
    where: { id: workItem.id },
    data: { status: 'SUBMITTED', currentRevision: revision },
  });

  await recordActivity(db, {
    actor,
    entityType: 'work_item',
    entityId: workItem.id,
    projectId: workItem.projectId,
    expertId: workItem.expertId,
    action: 'work.submitted',
    summary: `${workItem.expert.fullName} submitted ${workItem.reference} (revision ${revision})`,
    metadata: {
      revision,
      hoursClaimed: hoursScaled === null ? null : quantityToString(hoursScaled),
    },
  });

  await enqueueJob(db, {
    type: 'work.review_task',
    payload: { workItemId: workItem.id },
    priority: 30,
    dedupeKey: `work.review_task:${workItem.id}:${revision}`,
  });

  return { workItem, submission, revision };
}

export interface ReviewWorkInput {
  workItemId: string;
  approve: boolean;
  summary?: string;
  /** Structured per-dimension notes, e.g. { accuracy: '...', clarity: '...' }. */
  feedback?: Record<string, string>;
  revisionRequest?: string;
  /** Quantity the reviewer authorises for payment. Defaults to what was claimed. */
  approvedQuantity?: string | number;
}

export const FEEDBACK_DIMENSIONS = ['accuracy', 'completeness', 'clarity', 'methodology'] as const;

/**
 * HUMAN DECISION. Review one submission.
 *
 * Approving sets the authorised quantity, which is the only thing payment
 * preparation will read. A reviewer can approve fewer hours than were claimed;
 * the difference becomes a discrepancy flag on the payment item rather than a
 * silent adjustment.
 */
export async function reviewWork(db: Db, actor: Actor, input: ReviewWorkInput) {
  const workItem = await db.workItem.findUnique({
    where: { id: input.workItemId },
    include: {
      expert: true,
      project: true,
      submissions: { orderBy: { revision: 'desc' }, take: 1 },
    },
  });
  if (!workItem) throw notFound('Work item not found.');

  const submission = workItem.submissions[0];
  if (!submission) throw invalidState('There is nothing submitted to review yet.');

  assertWorkTransition(workItem.status, input.approve ? 'APPROVED' : 'REVISION_REQUESTED');

  if (!input.approve && !input.revisionRequest?.trim()) {
    throw badRequest('Requesting a revision needs a specific description of what to change.');
  }

  for (const key of Object.keys(input.feedback ?? {})) {
    if (!FEEDBACK_DIMENSIONS.includes(key as (typeof FEEDBACK_DIMENSIONS)[number])) {
      throw badRequest(
        `Unknown feedback dimension "${key}". Expected one of: ${FEEDBACK_DIMENSIONS.join(', ')}.`,
      );
    }
  }

  let approvedScaled: number | null = null;
  if (input.approve) {
    const raw =
      input.approvedQuantity ??
      (workItem.basis === 'HOURLY' ? (submission.hoursClaimed?.toString() ?? '0') : '1');
    approvedScaled = toQuantityScaled(raw);
    if (approvedScaled <= 0) {
      throw badRequest('Approved quantity must be greater than zero.');
    }
  }

  const at = clockNow();

  const review = await db.workReview.create({
    data: {
      workItemId: workItem.id,
      submissionId: submission.id,
      reviewerId: actor.userId ?? null,
      state: input.approve ? 'APPROVED' : 'REVISION_REQUESTED',
      feedback: (input.feedback ?? {}) as Prisma.InputJsonValue,
      summary: input.summary?.trim() ?? '',
      revisionRequest: input.approve ? null : input.revisionRequest!.trim(),
      approvedQuantity: approvedScaled === null ? null : quantityToString(approvedScaled),
      decidedAt: at,
    },
  });

  await db.workItem.update({
    where: { id: workItem.id },
    data: input.approve
      ? {
          status: 'APPROVED',
          approvedAt: at,
          approvedQuantity: quantityToString(approvedScaled!),
        }
      : { status: 'REVISION_REQUESTED' },
  });

  await recordActivity(db, {
    actor,
    entityType: 'work_item',
    entityId: workItem.id,
    projectId: workItem.projectId,
    expertId: workItem.expertId,
    action: input.approve ? 'work.approved' : 'work.revision_requested',
    summary: input.approve
      ? `${actor.label} approved ${workItem.reference} from ${workItem.expert.fullName}`
      : `${actor.label} asked ${workItem.expert.fullName} to revise ${workItem.reference}`,
    metadata: {
      reviewId: review.id,
      revision: submission.revision,
      approvedQuantity: approvedScaled === null ? null : quantityToString(approvedScaled),
      claimedQuantity: submission.hoursClaimed?.toString() ?? null,
      // Stated explicitly so nobody reads a review as a standing judgement.
      affectsExpertRanking: false,
    },
  });

  if (input.approve) {
    await enqueueJob(db, {
      type: 'payment.draft_from_approved_work',
      payload: { workItemId: workItem.id },
      priority: 40,
      // Keyed on the review, so a retried job cannot draft a second payment.
      dedupeKey: `payment.draft:${review.id}`,
    });
  }

  return { workItem, review, submission };
}

export async function listWorkItems(
  db: Db,
  query: { projectId?: string; expertId?: string; status?: WorkItemStatus; limit?: number } = {},
) {
  const where: Prisma.WorkItemWhereInput = {};
  if (query.projectId) where.projectId = query.projectId;
  if (query.expertId) where.expertId = query.expertId;
  if (query.status) where.status = query.status;

  return db.workItem.findMany({
    where,
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
    take: Math.min(query.limit ?? 50, 200),
    include: {
      expert: { select: { id: true, reference: true, fullName: true } },
      project: { select: { id: true, code: true, title: true } },
      submissions: { orderBy: { revision: 'desc' }, take: 1 },
      reviews: { orderBy: { createdAt: 'desc' }, take: 1 },
      paymentItem: { select: { id: true, reference: true, status: true } },
    },
  });
}

export async function getWorkItem(db: Db, workItemId: string) {
  const workItem = await db.workItem.findUnique({
    where: { id: workItemId },
    include: {
      expert: true,
      project: true,
      assignment: true,
      submissions: { orderBy: { revision: 'desc' } },
      reviews: {
        orderBy: { createdAt: 'desc' },
        include: { reviewer: { select: { id: true, name: true } } },
      },
      paymentItem: true,
    },
  });
  if (!workItem) throw notFound('Work item not found.');
  return workItem;
}

/** The expert-facing view. Excludes anything operator-only by construction. */
export async function listWorkItemsForExpert(db: Db, expertId: string) {
  const items = await db.workItem.findMany({
    where: { expertId, status: { not: 'DRAFT' } },
    orderBy: [{ dueAt: 'asc' }],
    include: {
      project: { select: { id: true, code: true, title: true } },
      submissions: { orderBy: { revision: 'desc' } },
      reviews: { orderBy: { createdAt: 'desc' } },
    },
  });

  return items.map((item) => ({
    id: item.id,
    reference: item.reference,
    title: item.title,
    instructions: item.instructions,
    basis: item.basis,
    dueAt: item.dueAt,
    status: item.status,
    currentRevision: item.currentRevision,
    project: item.project,
    submissions: item.submissions.map((submission) => ({
      revision: submission.revision,
      summary: submission.summary,
      content: submission.content,
      hoursClaimed: submission.hoursClaimed?.toString() ?? null,
      submittedAt: submission.submittedAt,
    })),
    // Reviewer identity is not exposed; the feedback itself is.
    reviews: item.reviews.map((review) => ({
      state: review.state,
      summary: review.summary,
      feedback: review.feedback,
      revisionRequest: review.revisionRequest,
      decidedAt: review.decidedAt,
    })),
  }));
}

export async function workCounts(db: Db) {
  const grouped = await db.workItem.groupBy({ by: ['status'], _count: { _all: true } });
  const counts: Record<WorkItemStatus, number> = {
    DRAFT: 0,
    ASSIGNED: 0,
    SUBMITTED: 0,
    IN_REVIEW: 0,
    REVISION_REQUESTED: 0,
    APPROVED: 0,
    CANCELLED: 0,
  };
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
}
