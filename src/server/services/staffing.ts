import { type Assignment, type AssignmentStatus } from '@prisma/client';
import { type Db, isPrismaErrorCode, PG_UNIQUE_VIOLATION, type Transactor } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, capacityExceeded, conflict, invalidState, notFound } from '@/lib/errors';
import {
  assertTransition,
  ASSIGNMENT_TRANSITIONS,
  PROJECT_STATUSES_OPEN_FOR_STAFFING,
  STAFFABLE_EXPERT_STATUS,
} from '@/server/domain/state-machines';
import {
  renderAssignmentConfirmedEmail,
  renderAssignmentReleasedEmail,
} from '@/server/email/templates';
import { type Actor, recordActivity } from './activity';
import { enqueueJob } from './jobs';
import { declaredHoursForProject } from './availability';
import { queueMessage } from './outbox';
import { advanceProjectStatus } from './projects';

/**
 * Staffing.
 *
 * Seat capacity is the one place where two operators racing each other can
 * corrupt state, so confirmation runs inside a transaction that first takes a
 * `SELECT ... FOR UPDATE` row lock on the project. Every concurrent confirm
 * therefore queues behind the lock, re-counts seats, and the one that would
 * exceed capacity is rejected with CAPACITY_EXCEEDED.
 */
export interface ProposeAssignmentInput {
  projectId: string;
  expertId: string;
  allocationHoursPerWeek: number;
  rateCents?: number;
  startDate?: Date | null;
  endDate?: Date | null;
}

/** Lock the project row for the remainder of the caller's transaction. */
export async function lockProject(tx: Db, projectId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE
  `;
  if (rows.length === 0) throw notFound('Project not found.');
}

async function countSeatsTaken(tx: Db, projectId: string): Promise<number> {
  return tx.assignment.count({
    where: { projectId, status: { in: ['CONFIRMED', 'COMPLETED'] } },
  });
}

export async function proposeAssignment(
  db: Db,
  actor: Actor,
  input: ProposeAssignmentInput,
): Promise<Assignment> {
  const project = await db.project.findUnique({ where: { id: input.projectId } });
  if (!project) throw notFound('Project not found.');
  if (!PROJECT_STATUSES_OPEN_FOR_STAFFING.includes(project.status)) {
    throw invalidState(
      `Project ${project.code} is ${project.status}. Staffing is only possible while it is ${PROJECT_STATUSES_OPEN_FOR_STAFFING.join(', ')}.`,
    );
  }

  const expert = await db.expert.findUnique({ where: { id: input.expertId } });
  if (!expert) throw notFound('Expert not found.');

  // The core gate of the workflow: only an operator-verified expert is staffable.
  if (expert.status !== STAFFABLE_EXPERT_STATUS) {
    throw invalidState(
      `${expert.fullName} is ${expert.status}. Only ${STAFFABLE_EXPERT_STATUS} experts can be staffed, so their onboarding must be verified by an operator first.`,
      { expertStatus: expert.status },
    );
  }

  const invitation = await db.invitation.findUnique({
    where: { projectId_expertId: { projectId: input.projectId, expertId: input.expertId } },
  });
  if (!invitation || invitation.status !== 'ACCEPTED') {
    throw invalidState(
      `${expert.fullName} has not accepted an invitation to ${project.code}, so they cannot be assigned a seat.`,
      { invitationStatus: invitation?.status ?? null },
    );
  }

  if (
    !Number.isInteger(input.allocationHoursPerWeek) ||
    input.allocationHoursPerWeek < 1 ||
    input.allocationHoursPerWeek > 60
  ) {
    throw badRequest('Allocation must be between 1 and 60 hours per week.');
  }

  const declaredHours = await declaredHoursForProject(db, input.expertId, input.projectId);
  if (declaredHours === 0) {
    throw invalidState(
      `${expert.fullName} has not declared availability yet. Ask them to add a window in their portal before staffing.`,
    );
  }
  if (input.allocationHoursPerWeek > declaredHours) {
    throw invalidState(
      `Allocation of ${input.allocationHoursPerWeek}h/week exceeds the ${declaredHours}h/week ${expert.fullName} declared.`,
      { declaredHours },
    );
  }

  const rateCents = input.rateCents ?? expert.hourlyRateCents;
  if (rateCents < 0) throw badRequest('Rate cannot be negative.');

  const seat = {
    status: 'PROPOSED' as const,
    allocationHoursPerWeek: input.allocationHoursPerWeek,
    rateCents,
    currency: expert.currency,
    startDate: input.startDate ?? project.startDate,
    endDate: input.endDate ?? project.endDate,
    createdById: actor.userId ?? null,
  };

  /**
   * A released seat can be offered to the same person again.
   *
   * `RELEASED -> PROPOSED` is in the transition table, and the staffing screen
   * offers the propose form to anyone whose assignment is released — which is
   * exactly the state an expert is left in after they withdraw. There is one
   * assignment row per (project, expert), enforced by a unique index, so
   * re-proposing has to revive that row. Creating unconditionally made the
   * offered action fail with "already has an assignment record", and nobody who
   * had ever left a project could be staffed onto it again.
   */
  const existing = await db.assignment.findUnique({
    where: { projectId_expertId: { projectId: input.projectId, expertId: input.expertId } },
  });

  if (existing) {
    if (existing.status !== 'RELEASED') {
      throw conflict(
        `${expert.fullName} already has a ${existing.status.toLowerCase()} assignment on ${project.code}.`,
        { assignmentId: existing.id, status: existing.status },
      );
    }
    assertTransition('Assignment', ASSIGNMENT_TRANSITIONS, existing.status, 'PROPOSED');

    const revived = await db.assignment.update({
      where: { id: existing.id },
      data: { ...seat, releasedAt: null, releaseReason: null, confirmedAt: null },
    });

    await recordActivity(db, {
      actor,
      entityType: 'assignment',
      entityId: revived.id,
      projectId: input.projectId,
      expertId: input.expertId,
      action: 'assignment.proposed',
      summary: `${actor.label} proposed ${expert.fullName} for a seat on ${project.code}`,
      metadata: {
        allocationHoursPerWeek: input.allocationHoursPerWeek,
        rateCents,
        // Said plainly in the history: this is the same seat record coming back,
        // not a second one.
        revivedFrom: 'RELEASED',
      },
    });

    return revived;
  }

  try {
    const assignment = await db.assignment.create({
      data: { projectId: input.projectId, expertId: input.expertId, ...seat },
    });

    await recordActivity(db, {
      actor,
      entityType: 'assignment',
      entityId: assignment.id,
      projectId: input.projectId,
      expertId: input.expertId,
      action: 'assignment.proposed',
      summary: `${actor.label} proposed ${expert.fullName} for a seat on ${project.code}`,
      metadata: { allocationHoursPerWeek: input.allocationHoursPerWeek, rateCents },
    });

    return assignment;
  } catch (error) {
    // Two operators proposing the same person at once: the loser reports a
    // conflict rather than a unique-violation stack trace.
    if (isPrismaErrorCode(error, PG_UNIQUE_VIOLATION)) {
      throw conflict(`${expert.fullName} already has an assignment record on ${project.code}.`);
    }
    throw error;
  }
}

export interface ConfirmResult {
  assignment: Assignment;
  seatsFilled: number;
  seatsRequested: number;
  projectBecameActive: boolean;
}

/**
 * HUMAN OPERATOR CONFIRMATION that consumes a seat.
 *
 * Runs in its own transaction with a project row lock. Two concurrent confirms
 * for the last seat produce exactly one success and one CAPACITY_EXCEEDED.
 */
export async function confirmAssignment(
  client: Transactor,
  actor: Actor,
  assignmentId: string,
): Promise<ConfirmResult> {
  const result = await client.$transaction(async (tx) => {
    const assignment = await tx.assignment.findUnique({
      where: { id: assignmentId },
      include: { project: true, expert: true },
    });
    if (!assignment) throw notFound('Assignment not found.');

    assertTransition('Assignment', ASSIGNMENT_TRANSITIONS, assignment.status, 'CONFIRMED');

    // Serialise every confirm for this project behind one lock.
    await lockProject(tx, assignment.projectId);

    const project = await tx.project.findUniqueOrThrow({ where: { id: assignment.projectId } });
    if (!PROJECT_STATUSES_OPEN_FOR_STAFFING.includes(project.status)) {
      throw invalidState(
        `Project ${project.code} is ${project.status} and is not open for staffing.`,
      );
    }

    // Re-read the expert inside the lock: verification could have been revoked
    // between proposal and confirmation.
    const expert = await tx.expert.findUniqueOrThrow({ where: { id: assignment.expertId } });
    if (expert.status !== STAFFABLE_EXPERT_STATUS) {
      throw invalidState(
        `${expert.fullName} is ${expert.status} and can no longer be confirmed onto a seat.`,
      );
    }

    const seatsTaken = await countSeatsTaken(tx, project.id);
    if (seatsTaken >= project.seatsRequested) {
      throw capacityExceeded(
        `Project ${project.code} has no seats left (${seatsTaken}/${project.seatsRequested} filled).`,
        { seatsTaken, seatsRequested: project.seatsRequested },
      );
    }

    const now = clockNow();
    const claimed = await tx.assignment.updateMany({
      where: { id: assignmentId, status: 'PROPOSED' },
      data: { status: 'CONFIRMED', confirmedAt: now, releasedAt: null, releaseReason: null },
    });
    if (claimed.count === 0) {
      throw invalidState('This assignment was already confirmed or released by someone else.');
    }

    const seatsFilled = seatsTaken + 1;
    await tx.project.update({ where: { id: project.id }, data: { seatsFilled } });

    await recordActivity(tx, {
      actor,
      entityType: 'assignment',
      entityId: assignmentId,
      projectId: project.id,
      expertId: expert.id,
      action: 'assignment.confirmed',
      summary: `${actor.label} confirmed ${expert.fullName} onto ${project.code} (seat ${seatsFilled}/${project.seatsRequested})`,
      metadata: {
        seatsFilled,
        seatsRequested: project.seatsRequested,
        allocationHoursPerWeek: assignment.allocationHoursPerWeek,
        rateCents: assignment.rateCents,
      },
    });

    const rendered = renderAssignmentConfirmedEmail({
      expertName: expert.fullName,
      projectTitle: project.title,
      projectCode: project.code,
      clientName: project.clientName,
      hoursPerWeek: assignment.allocationHoursPerWeek,
      rateCents: assignment.rateCents,
      currency: assignment.currency,
      startDate: assignment.startDate,
      endDate: assignment.endDate,
    });
    await queueMessage(tx, {
      toEmail: expert.email,
      toName: expert.fullName,
      subject: rendered.subject,
      bodyText: rendered.bodyText,
      template: 'assignment.confirmed',
      relatedType: 'assignment',
      relatedId: assignmentId,
      projectId: project.id,
      expertId: expert.id,
    });

    const confirmed = await tx.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    return {
      assignment: confirmed,
      seatsFilled,
      seatsRequested: project.seatsRequested,
      projectStatus: project.status,
      projectId: project.id,
    };
  });

  await enqueueJob(client, {
    type: 'staffing.project_start_tasks',
    payload: { assignmentId },
    priority: 40,
    dedupeKey: `staffing.project_start_tasks:${assignmentId}`,
  });

  // Status advance happens after the lock is released so it cannot deadlock
  // against another confirm.
  let projectBecameActive = false;
  if (result.seatsFilled >= result.seatsRequested && result.projectStatus !== 'ACTIVE') {
    await advanceProjectStatus(client, actor, result.projectId, 'ACTIVE');
    projectBecameActive = true;
  }

  return {
    assignment: result.assignment,
    seatsFilled: result.seatsFilled,
    seatsRequested: result.seatsRequested,
    projectBecameActive,
  };
}

export interface ReleaseResult {
  assignment: Assignment;
  seatsFilled: number;
}

/**
 * Give a seat back. Also runs under the project lock so the count stays exact.
 *
 * Opens the transaction; the work itself is in `releaseAssignmentWithin` so a
 * caller that already holds a transaction can reuse the same implementation
 * instead of a parallel copy. Prisma cannot nest an interactive transaction, so
 * the split is what makes sharing possible at all.
 */
export async function releaseAssignment(
  client: Transactor,
  actor: Actor,
  assignmentId: string,
  reason: string,
): Promise<ReleaseResult> {
  return client.$transaction((tx) => releaseAssignmentWithin(tx, actor, assignmentId, reason));
}

/**
 * The body of a release, expecting to already be inside a transaction.
 *
 * Takes the project row lock itself, so a caller only has to supply the
 * transaction, not the lock.
 */
export async function releaseAssignmentWithin(
  tx: Db,
  actor: Actor,
  assignmentId: string,
  reason: string,
): Promise<ReleaseResult> {
  if (!reason.trim()) throw badRequest('A reason is required to release a seat.');

  const assignment = await tx.assignment.findUnique({
    where: { id: assignmentId },
    include: { project: true, expert: true },
  });
  if (!assignment) throw notFound('Assignment not found.');

  assertTransition('Assignment', ASSIGNMENT_TRANSITIONS, assignment.status, 'RELEASED');

  await lockProject(tx, assignment.projectId);

  const now = clockNow();
  const claimed = await tx.assignment.updateMany({
    where: { id: assignmentId, status: { in: ['PROPOSED', 'CONFIRMED'] } },
    data: {
      status: 'RELEASED',
      releasedAt: now,
      releaseReason: reason.trim().slice(0, 500),
      confirmedAt: null,
    },
  });
  if (claimed.count === 0) {
    throw invalidState('This assignment was already released or completed.');
  }

  const seatsFilled = await countSeatsTaken(tx, assignment.projectId);
  await tx.project.update({ where: { id: assignment.projectId }, data: { seatsFilled } });

  await recordActivity(tx, {
    actor,
    entityType: 'assignment',
    entityId: assignmentId,
    projectId: assignment.projectId,
    expertId: assignment.expertId,
    action: 'assignment.released',
    summary: `${actor.label} released ${assignment.expert.fullName} from ${assignment.project.code}`,
    metadata: { reason: reason.trim(), seatsFilled },
  });

  if (assignment.status === 'CONFIRMED') {
    const rendered = renderAssignmentReleasedEmail({
      expertName: assignment.expert.fullName,
      projectTitle: assignment.project.title,
      projectCode: assignment.project.code,
      reason: reason.trim(),
    });
    await queueMessage(tx, {
      toEmail: assignment.expert.email,
      toName: assignment.expert.fullName,
      subject: rendered.subject,
      bodyText: rendered.bodyText,
      template: 'assignment.released',
      relatedType: 'assignment',
      relatedId: assignmentId,
      projectId: assignment.projectId,
      expertId: assignment.expertId,
    });
  }

  const released = await tx.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
  return { assignment: released, seatsFilled };
}

export async function completeAssignment(
  db: Db,
  actor: Actor,
  assignmentId: string,
): Promise<Assignment> {
  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    include: { project: true, expert: true },
  });
  if (!assignment) throw notFound('Assignment not found.');
  assertTransition('Assignment', ASSIGNMENT_TRANSITIONS, assignment.status, 'COMPLETED');

  const updated = await db.assignment.update({
    where: { id: assignmentId },
    data: { status: 'COMPLETED' },
  });
  await recordActivity(db, {
    actor,
    entityType: 'assignment',
    entityId: assignmentId,
    projectId: assignment.projectId,
    expertId: assignment.expertId,
    action: 'assignment.completed',
    summary: `${assignment.expert.fullName} completed their engagement on ${assignment.project.code}`,
  });
  return updated;
}

export async function listAssignmentsForProject(db: Db, projectId: string) {
  return db.assignment.findMany({
    where: { projectId },
    include: { expert: true },
    orderBy: [{ createdAt: 'desc' }],
  });
}

export async function assignmentCounts(db: Db): Promise<Record<AssignmentStatus, number>> {
  const grouped = await db.assignment.groupBy({ by: ['status'], _count: { _all: true } });
  const counts: Record<AssignmentStatus, number> = {
    PROPOSED: 0,
    CONFIRMED: 0,
    RELEASED: 0,
    COMPLETED: 0,
  };
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
}

/**
 * Experts who accepted an invitation for this project and are ready to be
 * proposed, with the blocking reason when they are not.
 */
export async function listStaffingCandidates(db: Db, projectId: string) {
  const invitations = await db.invitation.findMany({
    where: { projectId, status: 'ACCEPTED' },
    include: {
      expert: {
        include: {
          onboardingCase: true,
          availability: { where: { OR: [{ projectId }, { projectId: null }] } },
          assignments: { where: { projectId } },
        },
      },
    },
    orderBy: { respondedAt: 'asc' },
  });

  return invitations.map((invitation) => {
    const expert = invitation.expert;
    const declaredHours = expert.availability.length
      ? Math.max(...expert.availability.map((w) => w.hoursPerWeek))
      : 0;
    const existingAssignment = expert.assignments[0] ?? null;

    let blockedReason: string | null = null;
    if (existingAssignment && existingAssignment.status !== 'RELEASED') {
      blockedReason = `Already ${existingAssignment.status.toLowerCase()} on this project`;
    } else if (expert.status !== STAFFABLE_EXPERT_STATUS) {
      blockedReason =
        expert.onboardingCase?.status === 'SUBMITTED'
          ? 'Waiting on operator verification'
          : `Onboarding not verified (expert is ${expert.status})`;
    } else if (declaredHours === 0) {
      blockedReason = 'No availability declared';
    }

    return {
      invitation,
      expert,
      declaredHours,
      existingAssignment,
      blockedReason,
      staffable: blockedReason === null,
    };
  });
}
