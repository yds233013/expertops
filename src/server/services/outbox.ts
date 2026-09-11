import { type OutboxStatus, type Prisma } from '@prisma/client';
import { type Db } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { type TemplateName } from '@/server/email/templates';

/**
 * SIMULATED email outbox.
 *
 * `queueMessage` writes a row. The worker's `outbox.dispatch` job flips it to
 * SENT. There is no SMTP client, no third-party email API and no network call
 * anywhere in this path - "delivery" means the row is marked SENT and becomes
 * visible in the operator Outbox screen.
 */
export interface QueueMessageInput {
  toEmail: string;
  toName?: string;
  subject: string;
  bodyText: string;
  template: TemplateName;
  relatedType?: string | null;
  relatedId?: string | null;
  projectId?: string | null;
  expertId?: string | null;
  devPortalUrl?: string | null;
}

export async function queueMessage(db: Db, input: QueueMessageInput) {
  return db.outboxMessage.create({
    data: {
      toEmail: input.toEmail,
      toName: input.toName ?? '',
      subject: input.subject,
      bodyText: input.bodyText,
      template: input.template,
      relatedType: input.relatedType ?? null,
      relatedId: input.relatedId ?? null,
      projectId: input.projectId ?? null,
      expertId: input.expertId ?? null,
      devPortalUrl: input.devPortalUrl ?? null,
      status: 'QUEUED',
    },
  });
}

export interface DispatchResult {
  attempted: number;
  delivered: number;
  failed: number;
  messageIds: string[];
}

/**
 * Mark queued messages as delivered.
 *
 * Claiming uses a conditional updateMany on (id, status=QUEUED) so two workers
 * running at once cannot both "deliver" the same message.
 */
export async function dispatchQueuedMessages(
  db: Db,
  options: { limit?: number; now?: Date } = {},
): Promise<DispatchResult> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
  const now = options.now ?? new Date();

  const queued = await db.outboxMessage.findMany({
    where: { status: 'QUEUED' },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  const delivered: string[] = [];
  for (const message of queued) {
    const claimed = await db.outboxMessage.updateMany({
      where: { id: message.id, status: 'QUEUED' },
      data: { status: 'SENT', sentAt: now, attempts: { increment: 1 }, lastError: null },
    });
    if (claimed.count === 1) delivered.push(message.id);
  }

  return {
    attempted: queued.length,
    delivered: delivered.length,
    failed: 0,
    messageIds: delivered,
  };
}

export interface OutboxQuery {
  status?: OutboxStatus;
  expertId?: string;
  projectId?: string;
  template?: string;
  search?: string;
  limit?: number;
  cursor?: string;
}

export async function listMessages(db: Db, query: OutboxQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const where: Prisma.OutboxMessageWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.expertId) where.expertId = query.expertId;
  if (query.projectId) where.projectId = query.projectId;
  if (query.template) where.template = query.template;
  if (query.search) {
    where.OR = [
      { subject: { contains: query.search, mode: 'insensitive' } },
      { toEmail: { contains: query.search, mode: 'insensitive' } },
      { bodyText: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const rows = await db.outboxMessage.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  return {
    messages: hasMore ? rows.slice(0, limit) : rows,
    nextCursor: hasMore ? (rows[limit - 1]?.id ?? null) : null,
  };
}

export async function getMessage(db: Db, id: string) {
  const message = await db.outboxMessage.findUnique({ where: { id } });
  if (!message) throw notFound('Outbox message not found.');
  return message;
}

export async function outboxCounts(db: Db) {
  const grouped = await db.outboxMessage.groupBy({ by: ['status'], _count: { _all: true } });
  const counts: Record<OutboxStatus, number> = { QUEUED: 0, SENT: 0, FAILED: 0 };
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
}
