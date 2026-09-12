import { type Invitation, type Prisma } from '@prisma/client';
import { type Db, isPrismaErrorCode, PG_UNIQUE_VIOLATION } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { getEnv } from '@/lib/env';
import { badRequest, conflict, invalidState, notFound } from '@/lib/errors';
import { hoursFromNow } from '@/lib/time';
import {
  assertTransition,
  INVITATION_STATUSES_BLOCKING_REINVITE,
  INVITATION_TRANSITIONS,
  PROJECT_STATUSES_OPEN_FOR_INVITATIONS,
} from '@/server/domain/state-machines';
import {
  renderInvitationEmail,
  renderInvitationExpiredEmail,
  renderInvitationReminderEmail,
} from '@/server/email/templates';
import { type Actor, expertActor, recordActivity } from './activity';
import { enqueueJob } from './jobs';
import { queueMessage } from './outbox';
import { issuePortalToken } from './portal-access';
import { advanceProjectStatus } from './projects';
import { startOnboarding } from './onboarding';

/**
 * Invitations.
 *
 * Creating an invitation is an operator action; "sending" it is a worker job
 * that renders a simulated email into the outbox. Accept/decline are expert
 * actions from the portal. Every one of those paths funnels through the
 * functions in this file - no route handler re-implements a rule.
 */
export interface CreateInvitationInput {
  projectId: string;
  expertId: string;
  message?: string;
  ttlHours?: number;
  matchCandidateId?: string | null;
}

export async function createInvitation(
  db: Db,
  actor: Actor,
  input: CreateInvitationInput,
): Promise<Invitation> {
  const project = await db.project.findUnique({ where: { id: input.projectId } });
  if (!project) throw notFound('Project not found.');
  if (!PROJECT_STATUSES_OPEN_FOR_INVITATIONS.includes(project.status)) {
    throw invalidState(
      `Project ${project.code} is ${project.status}. Invitations can only be sent while it is ${PROJECT_STATUSES_OPEN_FOR_INVITATIONS.join(', ')}.`,
    );
  }

  const expert = await db.expert.findUnique({ where: { id: input.expertId } });
  if (!expert) throw notFound('Expert not found.');
  if (expert.status === 'ARCHIVED') {
    throw invalidState(`${expert.fullName} is archived and cannot be invited.`);
  }

  // Inviting beyond the remaining seats is usually intentional (a funnel), but
  // inviting onto a project with no seats left is not.
  if (project.seatsFilled >= project.seatsRequested) {
    throw invalidState(
      `Project ${project.code} already has all ${project.seatsRequested} seat(s) filled.`,
    );
  }

  const ttlHours = input.ttlHours ?? getEnv().INVITATION_DEFAULT_TTL_HOURS;
  if (ttlHours < 1 || ttlHours > 24 * 60) {
    throw badRequest('Invitation response window must be between 1 hour and 60 days.');
  }
  const expiresAt = hoursFromNow(ttlHours);
  const message = (input.message ?? '').trim().slice(0, 2000);

  const existing = await db.invitation.findUnique({
    where: { projectId_expertId: { projectId: input.projectId, expertId: input.expertId } },
  });

  if (existing) {
    if (INVITATION_STATUSES_BLOCKING_REINVITE.includes(existing.status)) {
      throw conflict(
        `${expert.fullName} already has a ${existing.status} invitation for ${project.code}.`,
        { invitationId: existing.id, status: existing.status },
      );
    }
    // DECLINED / EXPIRED / WITHDRAWN may be reopened as a fresh DRAFT.
    assertTransition('Invitation', INVITATION_TRANSITIONS, existing.status, 'DRAFT');
    const reopened = await db.invitation.update({
      where: { id: existing.id },
      data: {
        status: 'DRAFT',
        message,
        expiresAt,
        sentAt: null,
        respondedAt: null,
        remindedAt: null,
        declineReason: null,
        withdrawReason: null,
        matchCandidateId: input.matchCandidateId ?? null,
        createdById: actor.userId ?? null,
      },
    });
    await recordActivity(db, {
      actor,
      entityType: 'invitation',
      entityId: reopened.id,
      projectId: project.id,
      expertId: expert.id,
      action: 'invitation.reopened',
      summary: `Invitation to ${expert.fullName} for ${project.code} reopened`,
      metadata: { previousStatus: existing.status, expiresAt: expiresAt.toISOString() },
    });
    await scheduleSend(db, reopened.id);
    await advanceProjectStatus(db, actor, project.id, 'INVITING');
    return reopened;
  }

  try {
    const invitation = await db.invitation.create({
      data: {
        projectId: input.projectId,
        expertId: input.expertId,
        matchCandidateId: input.matchCandidateId ?? null,
        message,
        expiresAt,
        createdById: actor.userId ?? null,
        status: 'DRAFT',
      },
    });

    await recordActivity(db, {
      actor,
      entityType: 'invitation',
      entityId: invitation.id,
      projectId: project.id,
      expertId: expert.id,
      action: 'invitation.created',
      summary: `${actor.label} invited ${expert.fullName} to ${project.code}`,
      metadata: { expiresAt: expiresAt.toISOString(), ttlHours },
    });

    await scheduleSend(db, invitation.id);
    await advanceProjectStatus(db, actor, project.id, 'INVITING');
    return invitation;
  } catch (error) {
    if (isPrismaErrorCode(error, PG_UNIQUE_VIOLATION)) {
      // Two operators clicked "invite" for the same expert simultaneously.
      throw conflict(`${expert.fullName} already has an invitation for ${project.code}.`);
    }
    throw error;
  }
}

/** Queue the simulated send. Deduped so a retry cannot double-send. */
async function scheduleSend(db: Db, invitationId: string) {
  await enqueueJob(db, {
    type: 'invitation.send',
    payload: { invitationId },
    priority: 20,
    dedupeKey: `invitation.send:${invitationId}:${clockNow().getTime()}`,
    // Keyed by the instant it was queued, so the key is unique per call and
    // deduplicates nothing beyond this moment.
    dedupeScope: 'DISPOSABLE',
  });
}

export interface SendResult {
  invitation: Invitation;
  outboxMessageId: string;
  portalUrl: string;
}

/**
 * Render and queue the invitation email, then mark the invitation SENT.
 *
 * Called by the worker (`invitation.send`). Safe to call twice: the status
 * guard turns the second call into a no-op rather than a second email.
 */
export async function sendInvitation(
  db: Db,
  actor: Actor,
  invitationId: string,
): Promise<SendResult | null> {
  const invitation = await db.invitation.findUnique({
    where: { id: invitationId },
    include: { project: true, expert: true },
  });
  if (!invitation) throw notFound('Invitation not found.');
  if (invitation.status !== 'DRAFT') {
    // Already sent, withdrawn or answered - nothing to do.
    return null;
  }

  const portalToken = await issuePortalToken(db, {
    expertId: invitation.expertId,
    purpose: 'INVITATION',
  });

  const rendered = renderInvitationEmail({
    expertName: invitation.expert.fullName,
    projectTitle: invitation.project.title,
    projectCode: invitation.project.code,
    clientName: invitation.project.clientName,
    message: invitation.message,
    expiresAt: invitation.expiresAt,
    portalUrl: portalToken.url,
    startDate: invitation.project.startDate,
    endDate: invitation.project.endDate,
    maxHourlyRateCents: invitation.project.maxHourlyRateCents,
    currency: invitation.expert.currency,
  });

  const message = await queueMessage(db, {
    toEmail: invitation.expert.email,
    toName: invitation.expert.fullName,
    subject: rendered.subject,
    bodyText: rendered.bodyText,
    template: 'invitation.sent',
    relatedType: 'invitation',
    relatedId: invitation.id,
    projectId: invitation.projectId,
    expertId: invitation.expertId,
    devPortalUrl: portalToken.url,
  });

  const claimed = await db.invitation.updateMany({
    where: { id: invitation.id, status: 'DRAFT' },
    data: { status: 'SENT', sentAt: clockNow() },
  });
  if (claimed.count === 0) {
    return null;
  }

  await recordActivity(db, {
    actor,
    entityType: 'invitation',
    entityId: invitation.id,
    projectId: invitation.projectId,
    expertId: invitation.expertId,
    action: 'invitation.sent',
    summary: `Simulated invitation email queued for ${invitation.expert.fullName}`,
    metadata: { outboxMessageId: message.id, simulated: true },
  });

  return {
    invitation: { ...invitation, status: 'SENT', sentAt: clockNow() },
    outboxMessageId: message.id,
    portalUrl: portalToken.url,
  };
}

export interface RespondInput {
  invitationId: string;
  accept: boolean;
  declineReason?: string;
}

/**
 * Expert accepts or declines from the portal.
 *
 * The status guard is a conditional update, so two clicks (or two tabs) cannot
 * both transition the invitation.
 */
export async function respondToInvitation(db: Db, expertId: string, input: RespondInput) {
  const invitation = await db.invitation.findUnique({
    where: { id: input.invitationId },
    include: { project: true, expert: true },
  });
  if (!invitation) throw notFound('Invitation not found.');
  if (invitation.expertId !== expertId) {
    throw notFound('Invitation not found.');
  }

  const target = input.accept ? 'ACCEPTED' : 'DECLINED';
  assertTransition('Invitation', INVITATION_TRANSITIONS, invitation.status, target);

  if (invitation.expiresAt.getTime() <= clockNow().getTime()) {
    throw invalidState('This invitation has expired and can no longer be answered.');
  }
  if (!input.accept && !input.declineReason?.trim()) {
    throw badRequest('Please give a short reason when declining.');
  }

  const now = clockNow();
  const claimed = await db.invitation.updateMany({
    where: { id: invitation.id, status: 'SENT' },
    data: {
      status: target,
      respondedAt: now,
      declineReason: input.accept ? null : input.declineReason!.trim().slice(0, 500),
    },
  });
  if (claimed.count === 0) {
    throw invalidState('This invitation was already answered.');
  }

  const actor = expertActor(invitation.expert);

  await recordActivity(db, {
    actor,
    entityType: 'invitation',
    entityId: invitation.id,
    projectId: invitation.projectId,
    expertId: invitation.expertId,
    action: input.accept ? 'invitation.accepted' : 'invitation.declined',
    summary: input.accept
      ? `${invitation.expert.fullName} accepted the invitation to ${invitation.project.code}`
      : `${invitation.expert.fullName} declined the invitation to ${invitation.project.code}`,
    metadata: { reason: input.accept ? null : (input.declineReason?.trim() ?? null) },
  });

  if (input.accept) {
    await startOnboarding(db, actor, invitation.expertId);
    await enqueueJob(db, {
      type: 'onboarding.start',
      payload: { expertId: invitation.expertId, invitationId: invitation.id },
      priority: 30,
      dedupeKey: `onboarding.start:${invitation.id}`,
    });
    await advanceProjectStatus(db, actor, invitation.projectId, 'STAFFING');
  }

  return db.invitation.findUniqueOrThrow({
    where: { id: invitation.id },
    include: { project: true, expert: true },
  });
}

export async function withdrawInvitation(
  db: Db,
  actor: Actor,
  invitationId: string,
  reason: string,
) {
  const invitation = await db.invitation.findUnique({
    where: { id: invitationId },
    include: { project: true, expert: true },
  });
  if (!invitation) throw notFound('Invitation not found.');
  assertTransition('Invitation', INVITATION_TRANSITIONS, invitation.status, 'WITHDRAWN');
  if (!reason.trim()) throw badRequest('A reason is required to withdraw an invitation.');

  const claimed = await db.invitation.updateMany({
    where: { id: invitationId, status: { in: ['DRAFT', 'SENT'] } },
    data: {
      status: 'WITHDRAWN',
      withdrawReason: reason.trim().slice(0, 500),
      respondedAt: clockNow(),
    },
  });
  if (claimed.count === 0) {
    throw invalidState('This invitation was already answered and cannot be withdrawn.');
  }

  await recordActivity(db, {
    actor,
    entityType: 'invitation',
    entityId: invitationId,
    projectId: invitation.projectId,
    expertId: invitation.expertId,
    action: 'invitation.withdrawn',
    summary: `${actor.label} withdrew the invitation to ${invitation.expert.fullName}`,
    metadata: { reason: reason.trim() },
  });

  return db.invitation.findUniqueOrThrow({ where: { id: invitationId } });
}

export interface ExpireResult {
  expiredCount: number;
  invitationIds: string[];
}

/**
 * AUTOMATED: close invitations whose deadline has passed.
 *
 * Run by the `invitation.expire` scheduled job. Each row is claimed with a
 * conditional update so overlapping workers cannot expire the same one twice.
 */
export async function expireOverdueInvitations(
  db: Db,
  options: { now?: Date; limit?: number } = {},
): Promise<ExpireResult> {
  const now = options.now ?? clockNow();
  const candidates = await db.invitation.findMany({
    where: { status: 'SENT', expiresAt: { lte: now } },
    take: options.limit ?? 100,
    include: { project: true, expert: true },
  });

  const expired: string[] = [];
  for (const invitation of candidates) {
    const claimed = await db.invitation.updateMany({
      where: { id: invitation.id, status: 'SENT' },
      data: { status: 'EXPIRED', respondedAt: now },
    });
    if (claimed.count === 0) continue;
    expired.push(invitation.id);

    await recordActivity(db, {
      actor: { type: 'SYSTEM', label: 'ExpertOps worker' },
      entityType: 'invitation',
      entityId: invitation.id,
      projectId: invitation.projectId,
      expertId: invitation.expertId,
      action: 'invitation.expired',
      summary: `Invitation to ${invitation.expert.fullName} for ${invitation.project.code} expired automatically`,
      metadata: { expiresAt: invitation.expiresAt.toISOString(), automated: true },
    });

    const rendered = renderInvitationExpiredEmail({
      expertName: invitation.expert.fullName,
      projectTitle: invitation.project.title,
      projectCode: invitation.project.code,
    });
    await queueMessage(db, {
      toEmail: invitation.expert.email,
      toName: invitation.expert.fullName,
      subject: rendered.subject,
      bodyText: rendered.bodyText,
      template: 'invitation.expired',
      relatedType: 'invitation',
      relatedId: invitation.id,
      projectId: invitation.projectId,
      expertId: invitation.expertId,
    });
  }

  return { expiredCount: expired.length, invitationIds: expired };
}

export interface RemindResult {
  remindedCount: number;
  invitationIds: string[];
}

/**
 * AUTOMATED: one reminder per open invitation.
 *
 * `remindedAt` is set in the claiming update, which is what makes "one
 * reminder" a database guarantee rather than a timing assumption.
 */
export async function remindPendingInvitations(
  db: Db,
  options: {
    remindAfterHours?: number;
    minHoursRemaining?: number;
    now?: Date;
    limit?: number;
  } = {},
): Promise<RemindResult> {
  const now = options.now ?? clockNow();
  const remindAfterHours = options.remindAfterHours ?? 24;
  const minHoursRemaining = options.minHoursRemaining ?? 2;
  const sentBefore = new Date(now.getTime() - remindAfterHours * 3_600_000);
  const expiresAfter = new Date(now.getTime() + minHoursRemaining * 3_600_000);

  const candidates = await db.invitation.findMany({
    where: {
      status: 'SENT',
      remindedAt: null,
      sentAt: { lte: sentBefore },
      expiresAt: { gt: expiresAfter },
    },
    take: options.limit ?? 50,
    include: { project: true, expert: true },
  });

  const reminded: string[] = [];
  for (const invitation of candidates) {
    const claimed = await db.invitation.updateMany({
      where: { id: invitation.id, status: 'SENT', remindedAt: null },
      data: { remindedAt: now },
    });
    if (claimed.count === 0) continue;
    reminded.push(invitation.id);

    const portalToken = await issuePortalToken(db, {
      expertId: invitation.expertId,
      purpose: 'INVITATION',
    });
    const rendered = renderInvitationReminderEmail({
      expertName: invitation.expert.fullName,
      projectTitle: invitation.project.title,
      projectCode: invitation.project.code,
      expiresAt: invitation.expiresAt,
      portalUrl: portalToken.url,
    });
    await queueMessage(db, {
      toEmail: invitation.expert.email,
      toName: invitation.expert.fullName,
      subject: rendered.subject,
      bodyText: rendered.bodyText,
      template: 'invitation.reminder',
      relatedType: 'invitation',
      relatedId: invitation.id,
      projectId: invitation.projectId,
      expertId: invitation.expertId,
      devPortalUrl: portalToken.url,
    });

    await recordActivity(db, {
      actor: { type: 'SYSTEM', label: 'ExpertOps worker' },
      entityType: 'invitation',
      entityId: invitation.id,
      projectId: invitation.projectId,
      expertId: invitation.expertId,
      action: 'invitation.reminded',
      summary: `Reminder queued for ${invitation.expert.fullName} (${invitation.project.code})`,
      metadata: { automated: true, remindAfterHours },
    });
  }

  return { remindedCount: reminded.length, invitationIds: reminded };
}

export async function listInvitationsForExpert(db: Db, expertId: string) {
  return db.invitation.findMany({
    where: { expertId },
    include: { project: { include: { requirements: { include: { skill: true } } } } },
    orderBy: [{ createdAt: 'desc' }],
  });
}

export async function listInvitationsForProject(db: Db, projectId: string) {
  return db.invitation.findMany({
    where: { projectId },
    include: { expert: true },
    orderBy: [{ createdAt: 'desc' }],
  });
}

export async function invitationCounts(db: Db) {
  const grouped = await db.invitation.groupBy({ by: ['status'], _count: { _all: true } });
  const counts = { DRAFT: 0, SENT: 0, ACCEPTED: 0, DECLINED: 0, EXPIRED: 0, WITHDRAWN: 0 };
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
}

export async function getInvitation(db: Db, invitationId: string) {
  const invitation = await db.invitation.findUnique({
    where: { id: invitationId },
    include: { project: true, expert: true },
  });
  if (!invitation) throw notFound('Invitation not found.');
  return invitation;
}

export type InvitationWhere = Prisma.InvitationWhereInput;
