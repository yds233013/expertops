import { type OutboxStatus, type Prisma } from '@prisma/client';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { notFound } from '@/lib/errors';
import { isPrismaErrorCode, PG_UNIQUE_VIOLATION } from '@/lib/db';
import { DELIVERED_FOOTER, SIMULATED_FOOTER, type TemplateName } from '@/server/email/templates';
import {
  emailConfig,
  emailProviderFor,
  recipientBlockReason,
  type EmailConfig,
  type EmailProvider,
} from '@/server/email/provider';

/**
 * Email outbox.
 *
 * `queueMessage` writes a row; the worker's `outbox.dispatch` job delivers it.
 * By default delivery is SIMULATED: the row is marked SENT and the operator
 * Outbox screen is the only place the message exists. With
 * `EMAIL_PROVIDER=resend` it is sent through Resend (see
 * `src/server/email/provider.ts` and `docs/integrations.md`).
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
  /**
   * Set when this message must exist at most once, whatever happens upstream.
   *
   * The job queue already refuses to run the same job twice, but a job is not
   * the only way a message gets queued: an operator can press a button twice,
   * and a retried request can arrive after the first one committed. The unique
   * index is what makes "at most once" true rather than likely.
   */
  dedupeKey?: string | null;
}

/** Write a message into the simulated outbox. */
export async function queueMessage(db: Db, input: QueueMessageInput) {
  return createMessage(db, input);
}

/**
 * Write a message at most once.
 *
 * Returns null when the key collides, which is a success rather than an error:
 * the message the caller wanted already exists, and a second copy is the
 * outcome the key was added to prevent. The job queue already refuses to run
 * the same job twice, but a job is not the only way a message gets queued — an
 * operator can press a button twice, and a retried request can arrive after the
 * first one committed. The unique index is what makes "at most once" true
 * rather than likely.
 */
export async function queueMessageOnce(db: Db, input: QueueMessageInput & { dedupeKey: string }) {
  const existing = await db.outboxMessage.findUnique({
    where: { dedupeKey: input.dedupeKey },
    select: { id: true },
  });
  if (existing) return null;

  try {
    return await createMessage(db, input);
  } catch (error) {
    // Two requests that both passed the check above; one of them loses here.
    if (isPrismaErrorCode(error, PG_UNIQUE_VIOLATION)) return null;
    throw error;
  }
}

async function createMessage(db: Db, input: QueueMessageInput) {
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
      dedupeKey: input.dedupeKey ?? null,
      status: 'QUEUED',
    },
  });
}

export interface DispatchResult {
  attempted: number;
  delivered: number;
  /** Permanently failed this run: rejected, or out of retries. */
  failed: number;
  /** Will be tried again on a later tick. */
  retrying: number;
  suppressed: number;
  messageIds: string[];
  failedIds: string[];
  provider: EmailProvider['name'];
}

/** Attempts before a message that keeps hitting retryable errors is given up on. */
export const MAX_SEND_ATTEMPTS = 5;

/**
 * Deliver queued messages through the configured provider.
 *
 * Per message: suppressed or blocked recipients are marked SUPPRESSED and never
 * sent; otherwise the provider is called and the row moves to SENT, back to
 * QUEUED with a recorded error, or to FAILED. Every status change is a
 * conditional update on `status = QUEUED`, so two workers cannot both record
 * the same message, and the provider's idempotency key stops them both
 * sending it.
 *
 * With the simulated provider nothing leaves the process and reserved test
 * domains are delivered as before, because the outbox screen is the delivery.
 */
export async function dispatchQueuedMessages(
  db: Db,
  options: { limit?: number; now?: Date; provider?: EmailProvider; config?: EmailConfig } = {},
): Promise<DispatchResult> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
  const now = options.now ?? clockNow();
  const config = options.config ?? emailConfig();
  const provider = options.provider ?? emailProviderFor(config);
  const real = provider.name !== 'simulated';

  const queued = await db.outboxMessage.findMany({
    where: { status: 'QUEUED' },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  const result: DispatchResult = {
    attempted: queued.length,
    delivered: 0,
    failed: 0,
    retrying: 0,
    suppressed: 0,
    messageIds: [],
    failedIds: [],
    provider: provider.name,
  };

  const suppressedAddresses = real
    ? new Set(
        (
          await db.emailSuppression.findMany({
            where: { email: { in: queued.map((message) => message.toEmail.toLowerCase()) } },
            select: { email: true, reason: true },
          })
        ).map((row) => row.email),
      )
    : new Set<string>();

  for (const message of queued) {
    const blocked = real
      ? suppressedAddresses.has(message.toEmail.toLowerCase())
        ? 'The address is on the suppression list after a bounce or complaint.'
        : recipientBlockReason(message.toEmail, config)
      : null;

    if (blocked) {
      const marked = await db.outboxMessage.updateMany({
        where: { id: message.id, status: 'QUEUED' },
        data: { status: 'SUPPRESSED', suppressedReason: blocked, provider: provider.name },
      });
      result.suppressed += marked.count;
      continue;
    }

    const outcome = await provider.send({
      id: message.id,
      to: message.toEmail,
      toName: message.toName,
      subject: message.subject,
      // The stored body keeps the simulated footer as the audit record of what
      // was rendered; the recipient gets a footer that is true for them.
      text: message.bodyText.replace(SIMULATED_FOOTER, DELIVERED_FOOTER),
    });

    if (outcome.kind === 'sent') {
      const marked = await db.outboxMessage.updateMany({
        where: { id: message.id, status: 'QUEUED' },
        data: {
          status: 'SENT',
          sentAt: now,
          attempts: { increment: 1 },
          lastError: null,
          provider: provider.name,
          providerMessageId: outcome.providerMessageId,
        },
      });
      if (marked.count === 1) {
        result.delivered += 1;
        result.messageIds.push(message.id);
      }
      continue;
    }

    const exhausted = outcome.kind === 'failed' || message.attempts + 1 >= MAX_SEND_ATTEMPTS;
    const marked = await db.outboxMessage.updateMany({
      where: { id: message.id, status: 'QUEUED' },
      data: {
        status: exhausted ? 'FAILED' : 'QUEUED',
        attempts: { increment: 1 },
        lastError: outcome.error.slice(0, 1000),
        provider: provider.name,
      },
    });
    if (marked.count === 0) continue;
    if (exhausted) {
      result.failed += 1;
      result.failedIds.push(message.id);
    } else {
      result.retrying += 1;
    }
  }

  return result;
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
  const counts: Record<OutboxStatus, number> = {
    QUEUED: 0,
    SENT: 0,
    FAILED: 0,
    SUPPRESSED: 0,
    BOUNCED: 0,
  };
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
}
