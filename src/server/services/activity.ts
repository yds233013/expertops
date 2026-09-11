import { type ActorType, type Prisma } from '@prisma/client';
import { type Db } from '@/lib/db';

/**
 * Append-only activity history.
 *
 * Recorded inside the caller's transaction so a workflow step and its history
 * entry are atomic: if the step rolls back, the history entry disappears too.
 */
export interface Actor {
  type: ActorType;
  userId?: string | null;
  expertId?: string | null;
  label: string;
}

export const SYSTEM_ACTOR: Actor = { type: 'SYSTEM', label: 'ExpertOps worker' };

export function operatorActor(user: { id: string; name: string; email: string }): Actor {
  return { type: 'OPERATOR', userId: user.id, label: `${user.name} <${user.email}>` };
}

export function expertActor(expert: { id: string; fullName: string }): Actor {
  return { type: 'EXPERT', expertId: expert.id, label: expert.fullName };
}

export interface RecordActivityInput {
  actor: Actor;
  entityType: string;
  entityId: string;
  action: string;
  summary: string;
  metadata?: Prisma.InputJsonValue;
  projectId?: string | null;
  expertId?: string | null;
  candidateId?: string | null;
}

export async function recordActivity(db: Db, input: RecordActivityInput) {
  return db.activityEvent.create({
    data: {
      actorType: input.actor.type,
      actorUserId: input.actor.userId ?? null,
      actorExpertId: input.actor.expertId ?? null,
      actorLabel: input.actor.label,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      summary: input.summary,
      metadata: input.metadata ?? {},
      projectId: input.projectId ?? null,
      expertId: input.expertId ?? input.actor.expertId ?? null,
      candidateId: input.candidateId ?? null,
    },
  });
}

export interface ActivityQuery {
  projectId?: string;
  expertId?: string;
  candidateId?: string;
  entityType?: string;
  entityId?: string;
  actions?: string[];
  actorType?: ActorType;
  limit?: number;
  cursor?: string;
}

export async function listActivity(db: Db, query: ActivityQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const where: Prisma.ActivityEventWhereInput = {};
  if (query.projectId) where.projectId = query.projectId;
  if (query.expertId) where.expertId = query.expertId;
  if (query.candidateId) where.candidateId = query.candidateId;
  if (query.entityType) where.entityType = query.entityType;
  if (query.entityId) where.entityId = query.entityId;
  if (query.actorType) where.actorType = query.actorType;
  if (query.actions?.length) where.action = { in: query.actions };

  const rows = await db.activityEvent.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  return {
    events: hasMore ? rows.slice(0, limit) : rows,
    nextCursor: hasMore ? (rows[limit - 1]?.id ?? null) : null,
  };
}
