import { type OffboardingTask, type OffboardingTaskStatus } from '@prisma/client';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, invalidState, notFound } from '@/lib/errors';
import { daysFromNow } from '@/lib/time';
import { type Actor, recordActivity } from './activity';

/**
 * Offboarding checklist.
 *
 * Every item is something a person does somewhere else and then confirms here.
 * ExpertOps does not revoke an account, terminate a contract or delete a
 * repository, and none of these tasks claim that it did: confirming a task
 * records that a named operator says they did it, and nothing more.
 */
export interface OffboardingTemplateItem {
  key: string;
  label: string;
  description: string;
  dueInDays: number;
}

export const OFFBOARDING_CHECKLIST: readonly OffboardingTemplateItem[] = [
  {
    key: 'access_revoked',
    label: 'Confirm client system access has been removed',
    description:
      'Whoever administers the client environment removes the expert, then confirms here. ExpertOps has no connection to any external system and cannot verify this.',
    dueInDays: 2,
  },
  {
    key: 'materials_returned',
    label: 'Confirm client materials are returned or destroyed',
    description: 'Per the confidentiality terms accepted during onboarding.',
    dueInDays: 5,
  },
  {
    key: 'final_work_approved',
    label: 'Confirm all work items are reviewed and closed',
    description: 'No work item should be left awaiting review when an engagement ends.',
    dueInDays: 3,
  },
  {
    key: 'payment_prepared',
    label: 'Confirm outstanding approved work is in a payment batch',
    description:
      'Preparation only. Whether the expert has actually been paid is settled in the finance process, not here.',
    dueInDays: 7,
  },
  {
    key: 'feedback_captured',
    label: 'Capture engagement feedback',
    description: 'Notes for whoever staffs this expert next. Optional but usually worth it.',
    dueInDays: 10,
  },
] as const;

export interface CreateTasksResult {
  created: number;
  existing: number;
  tasks: OffboardingTask[];
}

/**
 * Open the checklist for one expert leaving one project.
 *
 * Idempotent on (project, expert, key), so a retried job does not produce a
 * second copy of the list.
 */
export async function openOffboarding(
  db: Db,
  actor: Actor,
  input: {
    projectId: string;
    expertId: string;
    assignmentId?: string | null;
    ownerId?: string | null;
  },
): Promise<CreateTasksResult> {
  const project = await db.project.findUnique({ where: { id: input.projectId } });
  if (!project) throw notFound('Project not found.');
  const expert = await db.expert.findUnique({ where: { id: input.expertId } });
  if (!expert) throw notFound('Expert not found.');

  const at = clockNow();
  const tasks: OffboardingTask[] = [];
  let created = 0;
  let existing = 0;

  for (const item of OFFBOARDING_CHECKLIST) {
    const found = await db.offboardingTask.findUnique({
      where: {
        projectId_expertId_key: {
          projectId: input.projectId,
          expertId: input.expertId,
          key: item.key,
        },
      },
    });

    if (found) {
      existing += 1;
      tasks.push(found);
      continue;
    }

    tasks.push(
      await db.offboardingTask.create({
        data: {
          projectId: input.projectId,
          expertId: input.expertId,
          assignmentId: input.assignmentId ?? null,
          key: item.key,
          label: item.label,
          description: item.description,
          status: 'PENDING',
          ownerId: input.ownerId ?? actor.userId ?? null,
          dueAt: daysFromNow(item.dueInDays, at),
        },
      }),
    );
    created += 1;
  }

  if (created > 0) {
    await recordActivity(db, {
      actor,
      entityType: 'offboarding',
      entityId: `${input.projectId}:${input.expertId}`,
      projectId: input.projectId,
      expertId: input.expertId,
      action: 'offboarding.opened',
      summary: `Offboarding checklist opened for ${expert.fullName} on ${project.code}`,
      metadata: { created, existing, automated: actor.type === 'SYSTEM' },
    });
  }

  return { created, existing, tasks };
}

/**
 * HUMAN CONFIRMATION. Record that an operator did the thing.
 *
 * The note is required for exactly this reason: the system has no independent
 * evidence, so the operator's statement is the evidence.
 */
export async function confirmTask(
  db: Db,
  actor: Actor,
  input: { taskId: string; note: string; notApplicable?: boolean },
): Promise<OffboardingTask> {
  if (!input.note.trim()) {
    throw badRequest(
      'A confirmation note is required. ExpertOps cannot verify this itself, so your statement is the record.',
    );
  }

  const task = await db.offboardingTask.findUnique({
    where: { id: input.taskId },
    include: { expert: true, project: true },
  });
  if (!task) throw notFound('Offboarding task not found.');
  if (task.status !== 'PENDING') {
    throw invalidState(`This task is already ${task.status}.`);
  }

  const status: OffboardingTaskStatus = input.notApplicable ? 'NOT_APPLICABLE' : 'CONFIRMED';
  const at = clockNow();

  const claimed = await db.offboardingTask.updateMany({
    where: { id: input.taskId, status: 'PENDING' },
    data: {
      status,
      confirmedById: actor.userId ?? null,
      confirmedAt: at,
      confirmationNote: input.note.trim(),
    },
  });
  if (claimed.count === 0) throw invalidState('This task was already confirmed by someone else.');

  await recordActivity(db, {
    actor,
    entityType: 'offboarding',
    entityId: task.id,
    projectId: task.projectId,
    expertId: task.expertId,
    action: input.notApplicable ? 'offboarding.task_not_applicable' : 'offboarding.task_confirmed',
    summary: `${actor.label} confirmed "${task.label}" for ${task.expert.fullName} on ${task.project.code}`,
    metadata: {
      key: task.key,
      note: input.note.trim(),
      // Stated on the record so nobody later reads this as system verification.
      verifiedBySystem: false,
    },
  });

  return db.offboardingTask.findUniqueOrThrow({ where: { id: input.taskId } });
}

export async function listOffboardingTasks(
  db: Db,
  query: {
    projectId?: string;
    expertId?: string;
    status?: OffboardingTaskStatus;
    overdueOnly?: boolean;
    limit?: number;
  } = {},
) {
  return db.offboardingTask.findMany({
    where: {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.expertId ? { expertId: query.expertId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.overdueOnly ? { status: 'PENDING', dueAt: { lte: clockNow() } } : {}),
    },
    orderBy: [{ dueAt: 'asc' }],
    take: Math.min(query.limit ?? 100, 300),
    include: {
      expert: { select: { id: true, reference: true, fullName: true } },
      project: { select: { id: true, code: true, title: true } },
      owner: { select: { id: true, name: true } },
      confirmedBy: { select: { id: true, name: true } },
    },
  });
}

/** Open the checklist for everyone still assigned when a project closes. */
export async function openProjectOffboarding(
  db: Db,
  actor: Actor,
  projectId: string,
): Promise<{ experts: number; tasksCreated: number }> {
  const assignments = await db.assignment.findMany({
    where: { projectId, status: { in: ['CONFIRMED', 'COMPLETED'] } },
  });

  let tasksCreated = 0;
  for (const assignment of assignments) {
    const result = await openOffboarding(db, actor, {
      projectId,
      expertId: assignment.expertId,
      assignmentId: assignment.id,
    });
    tasksCreated += result.created;
  }

  return { experts: assignments.length, tasksCreated };
}

export async function offboardingCounts(db: Db) {
  const grouped = await db.offboardingTask.groupBy({ by: ['status'], _count: { _all: true } });
  const counts: Record<OffboardingTaskStatus, number> = {
    PENDING: 0,
    CONFIRMED: 0,
    NOT_APPLICABLE: 0,
  };
  for (const row of grouped) counts[row.status] = row._count._all;
  const overdue = await db.offboardingTask.count({
    where: { status: 'PENDING', dueAt: { lte: clockNow() } },
  });
  return { ...counts, overdue };
}
