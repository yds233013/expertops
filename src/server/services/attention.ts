import {
  type AttentionItem,
  type AttentionKind,
  type AttentionSeverity,
  type Prisma,
} from '@prisma/client';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, notFound } from '@/lib/errors';
import { type Actor, recordActivity, SYSTEM_ACTOR } from './activity';

/**
 * The "Needs attention" queue.
 *
 * Design rules, all enforced here rather than by convention at call sites:
 *
 *  * **One row per condition.** `dedupeKey` is unique and derived from the
 *    thing that is stuck, not from the moment it was noticed. A sweep running
 *    every minute therefore refreshes one row instead of creating sixty.
 *  * **Self-resolving.** `resolveIfPresent` is called by the same sweep that
 *    raises items, so a blocker that clears disappears without anyone clicking.
 *  * **Business blockers and automation failures are different things.** They
 *    share a table but never share a list: a failing job is an engineering
 *    problem, not something an operator can unblock by talking to an expert.
 *  * **Every item is actionable.** The type makes blocker, impact and
 *    nextAction required, so an item that cannot explain itself cannot exist.
 */
export interface RaiseAttentionInput {
  dedupeKey: string;
  category: string;
  title: string;
  blocker: string;
  impact: string;
  nextAction: string;
  kind?: AttentionKind;
  severity?: AttentionSeverity;
  ownerId?: string | null;
  dueAt?: Date | null;
  metadata?: Prisma.InputJsonValue;
  projectId?: string | null;
  expertId?: string | null;
  candidateId?: string | null;
  screeningId?: string | null;
  assignmentId?: string | null;
  workItemId?: string | null;
  supportRequestId?: string | null;
  paymentBatchId?: string | null;
  jobId?: string | null;
}

export interface RaiseResult {
  item: AttentionItem;
  created: boolean;
}

/**
 * Raise or refresh an attention item.
 *
 * Idempotent by `dedupeKey`. A repeat call updates the detail (a deadline may
 * have moved) and bumps `lastSeenAt`, but never produces a second alert for the
 * same unresolved condition. An item previously resolved is reopened, because
 * the condition has genuinely recurred.
 */
export async function raiseAttention(
  db: Db,
  input: RaiseAttentionInput,
  options: { now?: Date } = {},
): Promise<RaiseResult> {
  const at = options.now ?? clockNow();
  if (!input.dedupeKey.trim()) throw badRequest('An attention item needs a dedupe key.');

  const existing = await db.attentionItem.findUnique({ where: { dedupeKey: input.dedupeKey } });

  const data = {
    kind: input.kind ?? 'BUSINESS_BLOCKER',
    category: input.category,
    severity: input.severity ?? 'MEDIUM',
    title: input.title,
    blocker: input.blocker,
    impact: input.impact,
    nextAction: input.nextAction,
    ownerId: input.ownerId ?? null,
    dueAt: input.dueAt ?? null,
    metadata: input.metadata ?? {},
    projectId: input.projectId ?? null,
    expertId: input.expertId ?? null,
    candidateId: input.candidateId ?? null,
    screeningId: input.screeningId ?? null,
    assignmentId: input.assignmentId ?? null,
    workItemId: input.workItemId ?? null,
    supportRequestId: input.supportRequestId ?? null,
    paymentBatchId: input.paymentBatchId ?? null,
    jobId: input.jobId ?? null,
    lastSeenAt: at,
  };

  if (!existing) {
    const item = await db.attentionItem.create({
      data: { dedupeKey: input.dedupeKey, status: 'OPEN', ...data },
    });
    return { item, created: true };
  }

  const item = await db.attentionItem.update({
    where: { id: existing.id },
    data: {
      ...data,
      // A dismissed item stays dismissed until the condition clears and recurs.
      status: existing.status === 'RESOLVED' ? 'OPEN' : existing.status,
      resolvedAt: existing.status === 'RESOLVED' ? null : existing.resolvedAt,
      resolvedReason: existing.status === 'RESOLVED' ? null : existing.resolvedReason,
      // Preserve an owner an operator already assigned.
      ownerId: existing.ownerId ?? data.ownerId,
    },
  });
  return { item, created: false };
}

/**
 * Close an item because the underlying condition went away.
 *
 * Silent when there is nothing open, so a sweep can call it unconditionally.
 */
export async function resolveIfPresent(
  db: Db,
  dedupeKey: string,
  reason: string,
  options: { now?: Date } = {},
): Promise<boolean> {
  const at = options.now ?? clockNow();
  const result = await db.attentionItem.updateMany({
    where: { dedupeKey, status: { in: ['OPEN', 'DISMISSED'] } },
    data: { status: 'RESOLVED', resolvedAt: at, resolvedReason: reason },
  });
  return result.count > 0;
}

/** Bulk variant used by sweeps that recompute a whole category at once. */
export async function resolveMissing(
  db: Db,
  options: { categoryPrefix: string; keepDedupeKeys: string[]; reason: string; now?: Date },
): Promise<number> {
  const at = options.now ?? clockNow();
  const result = await db.attentionItem.updateMany({
    where: {
      status: 'OPEN',
      category: { startsWith: options.categoryPrefix },
      dedupeKey: { notIn: options.keepDedupeKeys.length ? options.keepDedupeKeys : ['__none__'] },
    },
    data: { status: 'RESOLVED', resolvedAt: at, resolvedReason: options.reason },
  });
  return result.count;
}

/** An operator explicitly setting an item aside, with a reason on the record. */
export async function dismissAttention(
  db: Db,
  actor: Actor,
  id: string,
  reason: string,
): Promise<AttentionItem> {
  if (!reason.trim()) throw badRequest('A reason is required to dismiss an item.');
  const item = await db.attentionItem.findUnique({ where: { id } });
  if (!item) throw notFound('Attention item not found.');

  const updated = await db.attentionItem.update({
    where: { id },
    data: { status: 'DISMISSED', resolvedReason: reason.trim(), resolvedAt: clockNow() },
  });

  await recordActivity(db, {
    actor,
    entityType: 'attention',
    entityId: id,
    projectId: item.projectId,
    expertId: item.expertId,
    action: 'attention.dismissed',
    summary: `${actor.label} dismissed "${item.title}"`,
    metadata: { reason: reason.trim(), category: item.category },
  });
  return updated;
}

export async function assignAttention(
  db: Db,
  actor: Actor,
  id: string,
  ownerId: string | null,
): Promise<AttentionItem> {
  const item = await db.attentionItem.findUnique({ where: { id } });
  if (!item) throw notFound('Attention item not found.');

  const updated = await db.attentionItem.update({ where: { id }, data: { ownerId } });
  await recordActivity(db, {
    actor,
    entityType: 'attention',
    entityId: id,
    projectId: item.projectId,
    expertId: item.expertId,
    action: ownerId ? 'attention.assigned' : 'attention.unassigned',
    summary: ownerId
      ? `${actor.label} took ownership of "${item.title}"`
      : `${actor.label} released "${item.title}"`,
  });
  return updated;
}

export interface AttentionQuery {
  kind?: AttentionKind;
  category?: string;
  severity?: AttentionSeverity;
  ownerId?: string;
  unassignedOnly?: boolean;
  projectId?: string;
  includeResolved?: boolean;
  overdueOnly?: boolean;
  limit?: number;
}

export async function listAttention(db: Db, query: AttentionQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 300);
  const where: Prisma.AttentionItemWhereInput = {};

  where.status = query.includeResolved ? undefined : 'OPEN';
  if (query.kind) where.kind = query.kind;
  if (query.category) where.category = query.category;
  if (query.severity) where.severity = query.severity;
  if (query.projectId) where.projectId = query.projectId;
  if (query.unassignedOnly) where.ownerId = null;
  else if (query.ownerId) where.ownerId = query.ownerId;
  if (query.overdueOnly) where.dueAt = { lte: clockNow() };

  return db.attentionItem.findMany({
    where,
    orderBy: [{ severity: 'desc' }, { dueAt: 'asc' }, { createdAt: 'asc' }],
    take: limit,
    include: {
      owner: { select: { id: true, name: true, email: true } },
      project: { select: { id: true, code: true, title: true } },
      expert: { select: { id: true, reference: true, fullName: true } },
      candidate: { select: { id: true, reference: true, fullName: true } },
    },
  });
}

export async function attentionCounts(db: Db) {
  const grouped = await db.attentionItem.groupBy({
    by: ['kind', 'severity'],
    where: { status: 'OPEN' },
    _count: { _all: true },
  });

  const counts = {
    businessBlockers: 0,
    automationFailures: 0,
    high: 0,
    medium: 0,
    low: 0,
    unassigned: 0,
    overdue: 0,
    total: 0,
  };

  for (const row of grouped) {
    const n = row._count._all;
    counts.total += n;
    if (row.kind === 'BUSINESS_BLOCKER') counts.businessBlockers += n;
    else counts.automationFailures += n;
    if (row.severity === 'HIGH') counts.high += n;
    else if (row.severity === 'MEDIUM') counts.medium += n;
    else counts.low += n;
  }

  counts.unassigned = await db.attentionItem.count({ where: { status: 'OPEN', ownerId: null } });
  counts.overdue = await db.attentionItem.count({
    where: { status: 'OPEN', dueAt: { lte: clockNow() } },
  });

  return counts;
}

/**
 * Record that an automation failed.
 *
 * Kept distinct from business blockers so a dead job never dilutes the operator's
 * real work queue, and so an engineer can see automation health on its own.
 */
export async function raiseAutomationFailure(
  db: Db,
  input: { jobId: string; jobType: string; error: string; attempts: number },
  options: { now?: Date } = {},
): Promise<RaiseResult> {
  return raiseAttention(
    db,
    {
      dedupeKey: `automation:job:${input.jobId}`,
      kind: 'AUTOMATION_FAILURE',
      category: 'automation.job_dead',
      severity: 'HIGH',
      title: `Background job "${input.jobType}" stopped retrying`,
      blocker: `The job failed ${input.attempts} time(s) and will not run again. Last error: ${input.error}`,
      impact:
        'Whatever this job was responsible for has not happened. Downstream steps may be silently waiting.',
      nextAction: 'Inspect the job on the Worker screen, fix the cause, then retry it.',
      jobId: input.jobId,
      metadata: { jobType: input.jobType, attempts: input.attempts, error: input.error },
    },
    options,
  );
}

export async function resolveAutomationFailure(db: Db, jobId: string): Promise<boolean> {
  return resolveIfPresent(db, `automation:job:${jobId}`, 'The job was retried and succeeded.');
}

/** Log that a sweep ran, for the audit trail, without spamming activity. */
export async function recordSweepSummary(
  db: Db,
  summary: { raised: number; resolved: number; category: string },
) {
  if (summary.raised === 0 && summary.resolved === 0) return;
  await recordActivity(db, {
    actor: SYSTEM_ACTOR,
    entityType: 'attention',
    entityId: summary.category,
    action: 'attention.swept',
    summary: `${summary.category}: raised ${summary.raised}, resolved ${summary.resolved}`,
    metadata: { ...summary, automated: true },
  });
}
