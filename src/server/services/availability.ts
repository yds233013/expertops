import { type AvailabilityWindow } from '@prisma/client';
import { type Db } from '@/lib/db';
import { badRequest, invalidState, notFound } from '@/lib/errors';
import { type Actor, recordActivity } from './activity';

/**
 * Availability windows.
 *
 * Declared by the expert in the portal after accepting an invitation. Staffing
 * uses them as the capacity signal, so overlapping windows for the same project
 * are rejected rather than silently summed.
 */
export interface AvailabilityInput {
  startAt: Date;
  endAt: Date;
  hoursPerWeek: number;
  projectId?: string | null;
  note?: string;
}

export const MAX_HOURS_PER_WEEK = 60;

export function validateWindow(input: AvailabilityInput): void {
  if (!(input.startAt instanceof Date) || Number.isNaN(input.startAt.getTime())) {
    throw badRequest('Availability start date is not a valid date.');
  }
  if (!(input.endAt instanceof Date) || Number.isNaN(input.endAt.getTime())) {
    throw badRequest('Availability end date is not a valid date.');
  }
  if (input.endAt.getTime() <= input.startAt.getTime()) {
    throw badRequest('Availability end must be after the start.');
  }
  if (!Number.isInteger(input.hoursPerWeek) || input.hoursPerWeek < 1) {
    throw badRequest('Hours per week must be a positive whole number.');
  }
  if (input.hoursPerWeek > MAX_HOURS_PER_WEEK) {
    throw badRequest(`Hours per week cannot exceed ${MAX_HOURS_PER_WEEK}.`);
  }
}

export function windowsOverlap(
  a: { startAt: Date; endAt: Date },
  b: { startAt: Date; endAt: Date },
): boolean {
  return a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime();
}

export async function declareAvailability(
  db: Db,
  actor: Actor,
  expertId: string,
  input: AvailabilityInput,
): Promise<AvailabilityWindow> {
  validateWindow(input);

  const expert = await db.expert.findUnique({ where: { id: expertId } });
  if (!expert) throw notFound('Expert not found.');
  if (expert.status === 'ARCHIVED') {
    throw invalidState('Archived experts cannot declare availability.');
  }

  if (input.projectId) {
    const project = await db.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw notFound('Project not found.');
    // Availability may only be attached to a project the expert accepted.
    const invitation = await db.invitation.findUnique({
      where: { projectId_expertId: { projectId: input.projectId, expertId } },
    });
    if (!invitation || invitation.status !== 'ACCEPTED') {
      throw invalidState(
        `You can only add project availability for ${project.code} after accepting its invitation.`,
      );
    }
  }

  const existing = await db.availabilityWindow.findMany({
    where: { expertId, projectId: input.projectId ?? null },
  });
  const clash = existing.find((window) => windowsOverlap(window, input));
  if (clash) {
    throw invalidState(
      'That window overlaps one you already declared. Edit or remove the existing window first.',
      { conflictingWindowId: clash.id },
    );
  }

  const window = await db.availabilityWindow.create({
    data: {
      expertId,
      projectId: input.projectId ?? null,
      startAt: input.startAt,
      endAt: input.endAt,
      hoursPerWeek: input.hoursPerWeek,
      note: input.note?.trim().slice(0, 500) ?? '',
    },
  });

  // Keep the profile-level capacity in step with the best declared window so
  // matching sees a realistic number.
  const maxHours = Math.max(input.hoursPerWeek, expert.weeklyCapacityHours);
  if (maxHours !== expert.weeklyCapacityHours) {
    await db.expert.update({ where: { id: expertId }, data: { weeklyCapacityHours: maxHours } });
  }

  await recordActivity(db, {
    actor,
    entityType: 'availability',
    entityId: window.id,
    expertId,
    projectId: input.projectId ?? null,
    action: 'availability.declared',
    summary: `${expert.fullName} declared ${input.hoursPerWeek}h/week availability`,
    metadata: {
      startAt: input.startAt.toISOString(),
      endAt: input.endAt.toISOString(),
      hoursPerWeek: input.hoursPerWeek,
    },
  });

  return window;
}

export async function removeAvailability(
  db: Db,
  actor: Actor,
  expertId: string,
  windowId: string,
): Promise<void> {
  const window = await db.availabilityWindow.findUnique({ where: { id: windowId } });
  if (!window || window.expertId !== expertId) throw notFound('Availability window not found.');

  await db.availabilityWindow.delete({ where: { id: windowId } });
  await recordActivity(db, {
    actor,
    entityType: 'availability',
    entityId: windowId,
    expertId,
    projectId: window.projectId,
    action: 'availability.removed',
    summary: 'Availability window removed',
  });
}

export async function listAvailability(db: Db, expertId: string) {
  return db.availabilityWindow.findMany({
    where: { expertId },
    orderBy: { startAt: 'asc' },
    include: { project: { select: { id: true, code: true, title: true } } },
  });
}

/**
 * Hours the expert has declared for a project, used by staffing to warn when an
 * allocation exceeds what the expert actually offered.
 */
export async function declaredHoursForProject(
  db: Db,
  expertId: string,
  projectId: string,
): Promise<number> {
  const windows = await db.availabilityWindow.findMany({
    where: { expertId, OR: [{ projectId }, { projectId: null }] },
  });
  if (windows.length === 0) return 0;
  return Math.max(...windows.map((window) => window.hoursPerWeek));
}
