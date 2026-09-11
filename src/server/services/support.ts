import {
  type Prisma,
  type SupportCategory,
  type SupportRequest,
  type SupportStatus,
} from '@prisma/client';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, invalidState, notFound } from '@/lib/errors';
import { formatReference, parseReferenceSequence } from '@/lib/ids';
import { hoursFromNow } from '@/lib/time';
import { type Actor, recordActivity } from './activity';

/**
 * Expert support requests.
 *
 * Two things make this more than a message list:
 *
 *  * A request can be marked as **blocking readiness or delivery**. That flag
 *    is read by staffing and by the attention sweep, so "this expert is stuck
 *    on access" stops being tribal knowledge.
 *  * Replies can be **internal only**. An operator can think out loud on the
 *    record without that reaching the expert.
 */
export const SUPPORT_REFERENCE_PREFIX = 'SUP';

/** Response targets by category, in hours. */
export const RESPONSE_TARGET_HOURS: Record<SupportCategory, number> = {
  ACCESS: 4,
  SCOPE_QUESTION: 8,
  TOOLING: 8,
  SCHEDULING: 24,
  PAYMENT: 24,
  OTHER: 24,
};

async function nextSupportReference(db: Db): Promise<string> {
  const latest = await db.supportRequest.findFirst({
    orderBy: { reference: 'desc' },
    select: { reference: true },
  });
  return formatReference(
    SUPPORT_REFERENCE_PREFIX,
    parseReferenceSequence(SUPPORT_REFERENCE_PREFIX, latest?.reference) + 1,
  );
}

export interface RaiseSupportInput {
  expertId: string;
  projectId?: string | null;
  category?: SupportCategory;
  subject: string;
  message: string;
}

export async function raiseSupportRequest(
  db: Db,
  actor: Actor,
  input: RaiseSupportInput,
): Promise<SupportRequest> {
  if (!input.subject.trim()) throw badRequest('A support request needs a subject.');
  if (!input.message.trim()) throw badRequest('A support request needs a message.');

  const expert = await db.expert.findUnique({ where: { id: input.expertId } });
  if (!expert) throw notFound('Expert not found.');

  // An expert can only raise a request against a project they are on.
  if (input.projectId) {
    const assignment = await db.assignment.findUnique({
      where: { projectId_expertId: { projectId: input.projectId, expertId: input.expertId } },
    });
    const invitation = await db.invitation.findUnique({
      where: { projectId_expertId: { projectId: input.projectId, expertId: input.expertId } },
    });
    if (!assignment && !invitation) {
      throw invalidState('You can only raise a request against a project you are involved in.');
    }
  }

  const category = input.category ?? 'OTHER';
  const at = clockNow();

  const request = await db.supportRequest.create({
    data: {
      reference: await nextSupportReference(db),
      expertId: input.expertId,
      projectId: input.projectId ?? null,
      category,
      subject: input.subject.trim(),
      message: input.message.trim(),
      status: 'OPEN',
      responseDueAt: hoursFromNow(RESPONSE_TARGET_HOURS[category], at),
    },
  });

  await recordActivity(db, {
    actor,
    entityType: 'support_request',
    entityId: request.id,
    expertId: input.expertId,
    projectId: input.projectId ?? null,
    action: 'support.raised',
    summary: `${expert.fullName} raised support request ${request.reference}: ${request.subject}`,
    metadata: { category, responseDueAt: request.responseDueAt?.toISOString() ?? null },
  });

  return request;
}

export interface ReplyInput {
  requestId: string;
  body: string;
  internalOnly?: boolean;
}

export async function replyToSupport(db: Db, actor: Actor, input: ReplyInput) {
  if (!input.body.trim()) throw badRequest('A reply cannot be empty.');

  const request = await db.supportRequest.findUnique({
    where: { id: input.requestId },
    include: { expert: true },
  });
  if (!request) throw notFound('Support request not found.');

  if (actor.type === 'EXPERT') {
    if (actor.expertId !== request.expertId) throw notFound('Support request not found.');
    if (input.internalOnly) throw badRequest('Experts cannot post internal notes.');
  }
  if (request.status === 'CLOSED') {
    throw invalidState('This request is closed. Raise a new one if something is still wrong.');
  }

  const at = clockNow();
  const isOperator = actor.type === 'OPERATOR';

  const reply = await db.supportReply.create({
    data: {
      requestId: request.id,
      authorType: isOperator ? 'OPERATOR' : 'EXPERT',
      authorUserId: isOperator ? (actor.userId ?? null) : null,
      authorExpertId: isOperator ? null : (actor.expertId ?? null),
      body: input.body.trim(),
      internalOnly: input.internalOnly ?? false,
      createdAt: at,
    },
  });

  // A public operator reply is what stops the response clock.
  const stopsClock = isOperator && !input.internalOnly;
  await db.supportRequest.update({
    where: { id: request.id },
    data: {
      firstRespondedAt: stopsClock ? (request.firstRespondedAt ?? at) : request.firstRespondedAt,
      status: input.internalOnly
        ? request.status
        : isOperator
          ? 'WAITING_ON_EXPERT'
          : 'WAITING_ON_OPS',
    },
  });

  await recordActivity(db, {
    actor,
    entityType: 'support_request',
    entityId: request.id,
    expertId: request.expertId,
    projectId: request.projectId,
    action: input.internalOnly ? 'support.internal_note' : 'support.replied',
    summary: input.internalOnly
      ? `${actor.label} added an internal note to ${request.reference}`
      : `${actor.label} replied to ${request.reference}`,
    metadata: { internalOnly: input.internalOnly ?? false },
  });

  return reply;
}

export async function assignSupport(
  db: Db,
  actor: Actor,
  requestId: string,
  ownerId: string | null,
) {
  const request = await db.supportRequest.findUnique({ where: { id: requestId } });
  if (!request) throw notFound('Support request not found.');

  const updated = await db.supportRequest.update({
    where: { id: requestId },
    data: { ownerId },
  });
  await recordActivity(db, {
    actor,
    entityType: 'support_request',
    entityId: requestId,
    expertId: request.expertId,
    action: 'support.assigned',
    summary: ownerId
      ? `${actor.label} took ownership of ${request.reference}`
      : `${actor.label} released ${request.reference}`,
  });
  return updated;
}

/**
 * Mark a request as genuinely blocking.
 *
 * An operator decision, not an inference from the message text. Readiness and
 * delivery checks read these flags directly.
 */
export async function setBlocking(
  db: Db,
  actor: Actor,
  input: { requestId: string; blocksReadiness?: boolean; blocksDelivery?: boolean; note?: string },
) {
  const request = await db.supportRequest.findUnique({
    where: { id: input.requestId },
    include: { expert: true },
  });
  if (!request) throw notFound('Support request not found.');

  const updated = await db.supportRequest.update({
    where: { id: input.requestId },
    data: {
      blocksReadiness: input.blocksReadiness ?? request.blocksReadiness,
      blocksDelivery: input.blocksDelivery ?? request.blocksDelivery,
    },
  });

  await recordActivity(db, {
    actor,
    entityType: 'support_request',
    entityId: input.requestId,
    expertId: request.expertId,
    projectId: request.projectId,
    action: 'support.blocking_changed',
    summary: `${actor.label} marked ${request.reference} as blocking readiness=${updated.blocksReadiness}, delivery=${updated.blocksDelivery}`,
    metadata: {
      blocksReadiness: updated.blocksReadiness,
      blocksDelivery: updated.blocksDelivery,
      note: input.note?.trim() ?? null,
    },
  });
  return updated;
}

export async function resolveSupport(
  db: Db,
  actor: Actor,
  input: { requestId: string; resolution: string; close?: boolean },
) {
  if (!input.resolution.trim()) throw badRequest('A resolution note is required.');

  const request = await db.supportRequest.findUnique({
    where: { id: input.requestId },
    include: { expert: true },
  });
  if (!request) throw notFound('Support request not found.');
  if (request.status === 'CLOSED') throw invalidState('This request is already closed.');

  const at = clockNow();
  await db.supportReply.create({
    data: {
      requestId: request.id,
      authorType: 'OPERATOR',
      authorUserId: actor.userId ?? null,
      body: input.resolution.trim(),
      internalOnly: false,
      createdAt: at,
    },
  });

  const updated = await db.supportRequest.update({
    where: { id: input.requestId },
    data: {
      status: input.close ? 'CLOSED' : 'RESOLVED',
      resolvedAt: at,
      resolvedById: actor.userId ?? null,
      firstRespondedAt: request.firstRespondedAt ?? at,
      // Resolving clears the blocks: the thing that was stuck no longer is.
      blocksReadiness: false,
      blocksDelivery: false,
    },
  });

  await recordActivity(db, {
    actor,
    entityType: 'support_request',
    entityId: input.requestId,
    expertId: request.expertId,
    projectId: request.projectId,
    action: 'support.resolved',
    summary: `${actor.label} resolved ${request.reference} for ${request.expert.fullName}`,
    metadata: { closed: Boolean(input.close) },
  });
  return updated;
}

export async function listSupportRequests(
  db: Db,
  query: {
    status?: SupportStatus;
    expertId?: string;
    projectId?: string;
    blockingOnly?: boolean;
    overdueOnly?: boolean;
    limit?: number;
  } = {},
) {
  const where: Prisma.SupportRequestWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.expertId) where.expertId = query.expertId;
  if (query.projectId) where.projectId = query.projectId;
  if (query.blockingOnly) {
    where.OR = [{ blocksReadiness: true }, { blocksDelivery: true }];
    where.status = { in: ['OPEN', 'WAITING_ON_EXPERT', 'WAITING_ON_OPS'] };
  }
  if (query.overdueOnly) {
    where.status = { in: ['OPEN', 'WAITING_ON_OPS'] };
    where.firstRespondedAt = null;
    where.responseDueAt = { lte: clockNow() };
  }

  return db.supportRequest.findMany({
    where,
    orderBy: [{ responseDueAt: 'asc' }, { createdAt: 'desc' }],
    take: Math.min(query.limit ?? 50, 200),
    include: {
      expert: { select: { id: true, reference: true, fullName: true, email: true } },
      project: { select: { id: true, code: true, title: true } },
      owner: { select: { id: true, name: true } },
      replies: { orderBy: { createdAt: 'asc' } },
    },
  });
}

export async function getSupportRequest(db: Db, requestId: string) {
  const request = await db.supportRequest.findUnique({
    where: { id: requestId },
    include: {
      expert: true,
      project: true,
      owner: { select: { id: true, name: true, email: true } },
      replies: {
        orderBy: { createdAt: 'asc' },
        include: { authorUser: { select: { id: true, name: true } } },
      },
    },
  });
  if (!request) throw notFound('Support request not found.');
  return request;
}

/**
 * The expert's own view.
 *
 * Internal notes are filtered out here, and the query is scoped by expertId so
 * one expert can never read another's thread.
 */
export async function listSupportForExpert(db: Db, expertId: string) {
  const requests = await db.supportRequest.findMany({
    where: { expertId },
    orderBy: { createdAt: 'desc' },
    include: {
      project: { select: { id: true, code: true, title: true } },
      replies: { orderBy: { createdAt: 'asc' } },
    },
  });

  return requests.map((request) => ({
    id: request.id,
    reference: request.reference,
    category: request.category,
    subject: request.subject,
    message: request.message,
    status: request.status,
    createdAt: request.createdAt,
    resolvedAt: request.resolvedAt,
    project: request.project,
    replies: request.replies
      .filter((reply) => !reply.internalOnly)
      .map((reply) => ({
        id: reply.id,
        authorType: reply.authorType,
        body: reply.body,
        createdAt: reply.createdAt,
      })),
  }));
}

export async function supportCounts(db: Db) {
  const grouped = await db.supportRequest.groupBy({ by: ['status'], _count: { _all: true } });
  const counts: Record<SupportStatus, number> = {
    OPEN: 0,
    WAITING_ON_EXPERT: 0,
    WAITING_ON_OPS: 0,
    RESOLVED: 0,
    CLOSED: 0,
  };
  for (const row of grouped) counts[row.status] = row._count._all;

  const blocking = await db.supportRequest.count({
    where: {
      status: { in: ['OPEN', 'WAITING_ON_EXPERT', 'WAITING_ON_OPS'] },
      OR: [{ blocksReadiness: true }, { blocksDelivery: true }],
    },
  });

  return { ...counts, blocking };
}
