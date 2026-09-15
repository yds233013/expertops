import { z } from 'zod';
import { type Db } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { badRequest } from '@/lib/errors';
import { hoursBetween } from '@/lib/time';
import { REMINDER_POLICY } from '@/server/domain/automation';
import { recordActivity, SYSTEM_ACTOR } from '@/server/services/activity';
import { raiseAttention, resolveIfPresent } from '@/server/services/attention';
import { purgeExpiredSessions } from '@/server/services/auth';
import { pruneLoginAttempts } from '@/server/services/login-protection';
import { pruneWorkerHeartbeats } from '@/server/services/worker-health';
import { acknowledgeApplication } from '@/server/services/candidates';
import {
  expireOverdueInvitations,
  remindPendingInvitations,
  sendInvitation,
} from '@/server/services/invitations';
import { pruneFinishedJobs, type JobType } from '@/server/services/jobs';
import { runMatching } from '@/server/services/matching';
import { openOffboarding, openProjectOffboarding } from '@/server/services/offboarding';
import {
  ensureOnboardingCase,
  findStalledOnboarding,
  getOnboardingCase,
  outstandingRequiredItems,
} from '@/server/services/onboarding';
import { dispatchQueuedMessages, queueMessage } from '@/server/services/outbox';
import { queueExpertMessage } from '@/server/services/contact-preferences';
import { buildReplacementBatch } from '@/server/services/outreach';
import { draftPaymentFromApprovedWork } from '@/server/services/payments';
import { issuePortalToken } from '@/server/services/portal-access';
import { expireOverdueScreenings } from '@/server/services/screening';
import {
  computeProjectGap,
  detectStaffingGaps,
  readinessBlocker,
} from '@/server/services/staffing-gaps';
import { renderOnboardingNudgeEmail, renderOnboardingStartEmail } from '@/server/email/templates';

/**
 * Job handlers.
 *
 * Each handler is a thin wrapper that parses its payload and calls the SAME
 * business service the HTTP layer calls. No business rule lives here.
 *
 * Every handler obeys three rules, because the queue delivers at least once and
 * a job may run long after it was scheduled:
 *
 *  1. **Re-read current state.** The payload says what happened; the database
 *     says what is true now.
 *  2. **Be harmless when stale.** A job whose reason has passed returns a
 *     "skipped" result and succeeds. It does not fail, because there is nothing
 *     wrong.
 *  3. **Respect the reminder policy.** Caps and suppression windows live in
 *     `REMINDER_POLICY` and are applied by the claiming update, so two workers
 *     cannot both send the same nudge.
 */
/**
 * What a handler is given.
 *
 * `db` and `client` are the *same* transaction. The worker runs each handler
 * inside one, so that the work and the job's completion commit or roll back
 * together: a worker that loses its lease mid-flight cannot leave half a side
 * effect behind. A handler must therefore not open a transaction of its own,
 * which is why `client` is a `Db` rather than a `Transactor`.
 */
export interface HandlerContext {
  db: Db;
  client: Db;
  now: Date;
}

export type JobHandler = (
  payload: unknown,
  ctx: HandlerContext,
) => Promise<Record<string, unknown>>;

const invitationPayload = z.object({ invitationId: z.string().min(1) });
const expertPayload = z.object({
  expertId: z.string().min(1),
  invitationId: z.string().optional(),
});
const projectPayload = z.object({ projectId: z.string().min(1) });
const matchingPayload = z.object({
  projectId: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
});
const remindPayload = z.object({
  remindAfterHours: z.number().positive().optional(),
  minHoursRemaining: z.number().nonnegative().optional(),
});
const nudgePayload = z.object({ nudgeAfterHours: z.number().positive().optional() });
const sweepPayload = z.object({ pruneJobsOlderThanDays: z.number().positive().optional() });

function parse<T>(schema: z.ZodType<T>, payload: unknown, jobType: string): T {
  const result = schema.safeParse(payload ?? {});
  if (!result.success) {
    throw badRequest(
      `Invalid payload for job "${jobType}": ${result.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

/**
 * Should a reminder be sent for this subject right now?
 *
 * Centralised so every reminder handler answers the question identically.
 */
export function reminderAllowed(input: {
  remindersSent: number;
  lastRemindedAt: Date | null;
  deadline: Date | null;
  now: Date;
  optedOut?: boolean;
}): { allowed: boolean; reason?: string } {
  if (input.optedOut) return { allowed: false, reason: 'recipient opted out of contact' };
  if (input.remindersSent >= REMINDER_POLICY.maxReminders) {
    return { allowed: false, reason: `reminder cap of ${REMINDER_POLICY.maxReminders} reached` };
  }
  if (
    input.lastRemindedAt &&
    hoursBetween(input.lastRemindedAt, input.now) < REMINDER_POLICY.minIntervalHours
  ) {
    return { allowed: false, reason: 'within the minimum reminder interval' };
  }
  if (input.deadline) {
    const hoursLeft = (input.deadline.getTime() - input.now.getTime()) / 3_600_000;
    if (hoursLeft <= REMINDER_POLICY.suppressWithinHoursOfDeadline) {
      return { allowed: false, reason: 'too close to the deadline to be useful' };
    }
    if (hoursLeft < 0) return { allowed: false, reason: 'the deadline has already passed' };
  }
  return { allowed: true };
}

export const HANDLERS: Record<JobType, JobHandler> = {
  // -------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------

  /** Render the invitation email into the simulated outbox and mark it SENT. */
  'invitation.send': async (payload, ctx) => {
    const { invitationId } = parse(invitationPayload, payload, 'invitation.send');
    const result = await sendInvitation(ctx.db, SYSTEM_ACTOR, invitationId);
    return result
      ? { sent: true, outboxMessageId: result.outboxMessageId }
      : { sent: false, skipped: 'invitation was no longer in DRAFT' };
  },

  'invitation.remind': async (payload, ctx) => {
    const options = parse(remindPayload, payload, 'invitation.remind');
    const result = await remindPendingInvitations(ctx.db, { ...options, now: ctx.now });
    return { remindedCount: result.remindedCount, invitationIds: result.invitationIds };
  },

  'invitation.expire': async (_payload, ctx) => {
    const result = await expireOverdueInvitations(ctx.db, { now: ctx.now });
    return { expiredCount: result.expiredCount, invitationIds: result.invitationIds };
  },

  // -------------------------------------------------------------------------
  // Onboarding
  // -------------------------------------------------------------------------

  'onboarding.start': async (payload, ctx) => {
    const { expertId } = parse(expertPayload, payload, 'onboarding.start');
    const expert = await ctx.db.expert.findUnique({ where: { id: expertId } });
    if (!expert) return { started: false, skipped: 'expert no longer exists' };
    if (expert.status === 'ARCHIVED') return { started: false, skipped: 'expert is archived' };

    await ensureOnboardingCase(ctx.db, expertId);
    const onboardingCase = await getOnboardingCase(ctx.db, expertId);
    const outstanding = outstandingRequiredItems(onboardingCase.items);
    if (outstanding.length === 0) {
      return { started: true, emailed: false, skipped: 'checklist already complete' };
    }

    const portal = await issuePortalToken(ctx.db, { expertId, purpose: 'ONBOARDING' });
    const rendered = renderOnboardingStartEmail({
      expertName: expert.fullName,
      portalUrl: portal.url,
      outstandingItems: outstanding.map((item) => item.label),
    });
    const message = await queueExpertMessage(ctx.db, {
      expertId,
      kind: 'OPERATIONAL',
      subject: rendered.subject,
      bodyText: rendered.bodyText,
      template: 'onboarding.start',
      relatedType: 'onboarding',
      relatedId: onboardingCase.id,
      devPortalUrl: portal.url,
    });
    return {
      started: true,
      emailed: message.queued,
      outboxMessageId: message.messageId,
      skipped: message.skippedReason,
    };
  },

  'onboarding.nudge': async (payload, ctx) => {
    const { nudgeAfterHours = 24 } = parse(nudgePayload, payload, 'onboarding.nudge');
    const stalled = await findStalledOnboarding(ctx.db, { nudgeAfterHours, now: ctx.now });

    const nudged: string[] = [];
    const suppressed: Array<{ expertId: string; reason: string }> = [];

    for (const onboardingCase of stalled) {
      const decision = reminderAllowed({
        remindersSent: onboardingCase.nudgedAt ? 1 : 0,
        lastRemindedAt: onboardingCase.nudgedAt,
        deadline: null,
        now: ctx.now,
      });
      if (!decision.allowed) {
        suppressed.push({ expertId: onboardingCase.expertId, reason: decision.reason! });
        continue;
      }

      // The claiming update is what stops two workers nudging the same person.
      const claimed = await ctx.db.onboardingCase.updateMany({
        where: {
          id: onboardingCase.id,
          status: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
          nudgedAt: onboardingCase.nudgedAt,
        },
        data: { nudgedAt: ctx.now },
      });
      if (claimed.count === 0) continue;

      const outstanding = outstandingRequiredItems(onboardingCase.items);
      const portal = await issuePortalToken(ctx.db, {
        expertId: onboardingCase.expertId,
        purpose: 'ONBOARDING',
      });
      const rendered = renderOnboardingNudgeEmail({
        expertName: onboardingCase.expert.fullName,
        portalUrl: portal.url,
        outstandingItems: outstanding.map((item) => item.label),
      });
      await queueExpertMessage(ctx.db, {
        expertId: onboardingCase.expertId,
        // A nudge is optional chasing, so a suppressed preference stops it.
        kind: 'REMINDER',
        subject: rendered.subject,
        bodyText: rendered.bodyText,
        template: 'onboarding.nudge',
        relatedType: 'onboarding',
        relatedId: onboardingCase.id,
        devPortalUrl: portal.url,
      });
      await recordActivity(ctx.db, {
        actor: SYSTEM_ACTOR,
        entityType: 'onboarding',
        entityId: onboardingCase.id,
        expertId: onboardingCase.expertId,
        action: 'onboarding.nudged',
        summary: `Nudge queued for ${onboardingCase.expert.fullName}`,
        metadata: { automated: true, outstanding: outstanding.length },
      });
      nudged.push(onboardingCase.expertId);
    }

    return { nudgedCount: nudged.length, suppressed };
  },

  // -------------------------------------------------------------------------
  // Applications and screening
  // -------------------------------------------------------------------------

  /** Acknowledge an application and open the screening task. */
  'application.acknowledge': async (payload, ctx) => {
    const schema = z.object({ applicationId: z.string().min(1) });
    const { applicationId } = parse(schema, payload, 'application.acknowledge');

    const application = await ctx.db.application.findUnique({
      where: { id: applicationId },
      include: { candidate: true, domain: true },
    });
    if (!application) return { acknowledged: false, skipped: 'application no longer exists' };
    if (application.status !== 'SUBMITTED') {
      return { acknowledged: false, skipped: `application is ${application.status}` };
    }
    if (application.candidate.contactOptOutAt) {
      return { acknowledged: false, skipped: 'candidate opted out of contact' };
    }

    const acknowledged = await acknowledgeApplication(ctx.db, applicationId, { now: ctx.now });
    if (!acknowledged) return { acknowledged: false, skipped: 'already acknowledged' };

    const message = await queueMessage(ctx.db, {
      toEmail: application.candidate.email,
      toName: application.candidate.fullName,
      subject: `We received your application (${application.reference})`,
      bodyText: [
        `Hello ${application.candidate.fullName},`,
        '',
        `Thank you for applying to work with us on ${application.domain.name}.`,
        `Your reference is ${application.reference}.`,
        '',
        'A member of the team will review your application and, if it looks like a fit,',
        'send you a screening exercise. Nothing is decided automatically: a person',
        'reads every application.',
        '',
        '--',
        'ExpertOps (local development instance)',
        'This message was generated by a simulated outbox and was not delivered to any mail server.',
      ].join('\n'),
      template: 'invitation.sent',
      relatedType: 'application',
      relatedId: application.id,
    });

    // A screening still has to be started by a human choosing a rubric.
    await raiseAttention(
      ctx.db,
      {
        dedupeKey: `screening:needed:${application.candidateId}:${application.domainId}`,
        category: 'screening.not_started',
        severity: 'MEDIUM',
        title: `${application.candidate.fullName} applied and needs a screening`,
        blocker: `Application ${application.reference} for ${application.domain.name} is acknowledged but no screening has been started.`,
        impact: 'The candidate is waiting and the pipeline is not moving.',
        nextAction: 'Open the candidate and start a screening against the current rubric version.',
        candidateId: application.candidateId,
        metadata: { applicationId: application.id, domain: application.domain.name },
      },
      { now: ctx.now },
    );

    return { acknowledged: true, outboxMessageId: message.id, simulated: true };
  },

  /** Email a candidate their screening portal link. */
  'screening.invite': async (payload, ctx) => {
    const schema = z.object({ screeningId: z.string().min(1) });
    const { screeningId } = parse(schema, payload, 'screening.invite');

    const screening = await ctx.db.screening.findUnique({
      where: { id: screeningId },
      include: {
        candidate: true,
        rubricVersion: { include: { template: { include: { domain: true } } } },
      },
    });
    if (!screening) return { sent: false, skipped: 'screening no longer exists' };
    if (screening.status !== 'INVITED' && screening.status !== 'REVISION_REQUESTED') {
      return { sent: false, skipped: `screening is ${screening.status}` };
    }
    if (screening.candidate.contactOptOutAt) {
      return { sent: false, skipped: 'candidate opted out of contact' };
    }

    const { issueCandidatePortalToken } = await import('@/server/services/candidate-portal');
    const portal = await issueCandidatePortalToken(ctx.db, { candidateId: screening.candidateId });

    const message = await queueMessage(ctx.db, {
      toEmail: screening.candidate.email,
      toName: screening.candidate.fullName,
      subject: `Screening exercise: ${screening.rubricVersion.template.domain.name} (${screening.reference})`,
      bodyText: [
        `Hello ${screening.candidate.fullName},`,
        '',
        `We would like you to complete a short screening exercise for ${screening.rubricVersion.template.domain.name} work.`,
        '',
        screening.rubricVersion.guidance,
        '',
        `Please submit by ${screening.dueAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
        '',
        'Open your screening here:',
        portal.url,
        '',
        '--',
        'ExpertOps (local development instance)',
        'This message was generated by a simulated outbox and was not delivered to any mail server.',
      ].join('\n'),
      template: 'invitation.sent',
      relatedType: 'screening',
      relatedId: screening.id,
      devPortalUrl: portal.url,
    });

    return { sent: true, outboxMessageId: message.id, simulated: true };
  },

  /** One reminder per open screening, subject to the reminder policy. */
  'screening.remind_candidate': async (_payload, ctx) => {
    const open = await ctx.db.screening.findMany({
      where: { status: { in: ['INVITED', 'REVISION_REQUESTED'] }, dueAt: { gt: ctx.now } },
      include: { candidate: true },
      take: 50,
    });

    const reminded: string[] = [];
    const suppressed: Array<{ screeningId: string; reason: string }> = [];

    for (const screening of open) {
      const decision = reminderAllowed({
        remindersSent: screening.remindersSent,
        lastRemindedAt: screening.lastRemindedAt,
        deadline: screening.dueAt,
        now: ctx.now,
        optedOut: Boolean(screening.candidate.contactOptOutAt),
      });
      if (!decision.allowed) {
        suppressed.push({ screeningId: screening.id, reason: decision.reason! });
        continue;
      }

      // Only remind once the candidate has had a reasonable run at it.
      const hoursSinceInvite = hoursBetween(screening.invitedAt, ctx.now);
      if (hoursSinceInvite < 48) {
        suppressed.push({ screeningId: screening.id, reason: 'invited less than 48 hours ago' });
        continue;
      }

      const claimed = await ctx.db.screening.updateMany({
        where: {
          id: screening.id,
          status: { in: ['INVITED', 'REVISION_REQUESTED'] },
          remindersSent: screening.remindersSent,
        },
        data: { remindersSent: { increment: 1 }, lastRemindedAt: ctx.now },
      });
      if (claimed.count === 0) continue;

      const { issueCandidatePortalToken } = await import('@/server/services/candidate-portal');
      const portal = await issueCandidatePortalToken(ctx.db, {
        candidateId: screening.candidateId,
      });

      await queueMessage(ctx.db, {
        toEmail: screening.candidate.email,
        toName: screening.candidate.fullName,
        subject: `Reminder: your screening ${screening.reference} is still open`,
        bodyText: [
          `Hello ${screening.candidate.fullName},`,
          '',
          `Your screening exercise is still open and closes on ${screening.dueAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
          '',
          portal.url,
          '',
          '--',
          'ExpertOps (local development instance)',
          'This message was generated by a simulated outbox and was not delivered to any mail server.',
        ].join('\n'),
        template: 'invitation.reminder',
        relatedType: 'screening',
        relatedId: screening.id,
        devPortalUrl: portal.url,
      });
      reminded.push(screening.id);
    }

    return { remindedCount: reminded.length, suppressed };
  },

  'screening.expire': async (_payload, ctx) => {
    const result = await expireOverdueScreenings(ctx.db, { now: ctx.now });
    return { expiredCount: result.expiredCount, screeningIds: result.screeningIds };
  },

  /**
   * Try to assign a reviewer automatically.
   *
   * Picks the operator with the fewest open reviews. When nobody is eligible it
   * raises an unassigned-review exception rather than guessing or silently
   * leaving the screening in limbo.
   */
  'screening.assign_reviewer': async (payload, ctx) => {
    const schema = z.object({ screeningId: z.string().min(1) });
    const { screeningId } = parse(schema, payload, 'screening.assign_reviewer');

    const screening = await ctx.db.screening.findUnique({
      where: { id: screeningId },
      include: { candidate: true, reviews: true },
    });
    if (!screening) return { assigned: false, skipped: 'screening no longer exists' };
    if (!['SUBMITTED', 'IN_REVIEW'].includes(screening.status)) {
      return { assigned: false, skipped: `screening is ${screening.status}` };
    }
    if (screening.reviews.some((review) => review.state === 'ASSIGNED')) {
      return { assigned: false, skipped: 'a reviewer is already assigned' };
    }

    const dedupeKey = `screening:unassigned:${screeningId}`;

    const eligible = await ctx.db.user.findMany({
      where: { isActive: true, role: { in: ['ADMIN', 'OPERATOR'] } },
      include: {
        screeningReviews: { where: { state: 'ASSIGNED' }, select: { id: true } },
      },
    });

    const alreadyReviewed = new Set(screening.reviews.map((review) => review.reviewerId));
    const available = eligible
      .filter((user) => !alreadyReviewed.has(user.id))
      .sort((a, b) => a.screeningReviews.length - b.screeningReviews.length);

    if (available.length === 0) {
      await raiseAttention(
        ctx.db,
        {
          dedupeKey,
          category: 'screening.unassigned_review',
          severity: 'HIGH',
          title: `No reviewer available for ${screening.reference}`,
          blocker: `${screening.candidate.fullName} submitted a screening but there is no eligible operator to review it.`,
          impact: 'The candidate is waiting and cannot be qualified.',
          nextAction:
            'Assign a reviewer manually, or activate an operator account with review rights.',
          screeningId,
          candidateId: screening.candidateId,
        },
        { now: ctx.now },
      );
      return { assigned: false, exception: 'no eligible reviewer', attentionRaised: true };
    }

    const { assignReviewer } = await import('@/server/services/screening');
    const review = await assignReviewer(ctx.db, SYSTEM_ACTOR, {
      screeningId,
      reviewerId: available[0]!.id,
    });

    await resolveIfPresent(ctx.db, dedupeKey, 'A reviewer was assigned.', { now: ctx.now });

    return { assigned: true, reviewerId: review.reviewerId, reviewId: review.id };
  },

  /** Remind a reviewer whose deadline has passed. Capped and suppressed. */
  'review.remind': async (_payload, ctx) => {
    const overdue = await ctx.db.screeningReview.findMany({
      where: { state: 'ASSIGNED', dueAt: { lte: ctx.now } },
      include: {
        reviewer: true,
        screening: { include: { candidate: true } },
      },
      take: 50,
    });

    const reminded: string[] = [];
    const suppressed: Array<{ reviewId: string; reason: string }> = [];

    for (const review of overdue) {
      const decision = reminderAllowed({
        remindersSent: review.remindersSent,
        lastRemindedAt: review.lastRemindedAt,
        // The deadline has already passed, so the suppression window does not
        // apply: this is a chase, not a courtesy nudge.
        deadline: null,
        now: ctx.now,
      });
      if (!decision.allowed) {
        suppressed.push({ reviewId: review.id, reason: decision.reason! });
        continue;
      }

      const claimed = await ctx.db.screeningReview.updateMany({
        where: { id: review.id, state: 'ASSIGNED', remindersSent: review.remindersSent },
        data: { remindersSent: { increment: 1 }, lastRemindedAt: ctx.now },
      });
      if (claimed.count === 0) continue;

      await queueMessage(ctx.db, {
        toEmail: review.reviewer.email,
        toName: review.reviewer.name,
        subject: `Review overdue: ${review.screening.reference}`,
        bodyText: [
          `Hello ${review.reviewer.name},`,
          '',
          `Your review of ${review.screening.reference} (${review.screening.candidate.fullName}) was due on`,
          `${review.dueAt.toISOString().slice(0, 16).replace('T', ' ')} UTC and is still outstanding.`,
          '',
          'The candidate is waiting on this decision.',
          '',
          '--',
          'ExpertOps (local development instance)',
          'This message was generated by a simulated outbox and was not delivered to any mail server.',
        ].join('\n'),
        template: 'invitation.reminder',
        relatedType: 'screening_review',
        relatedId: review.id,
      });
      reminded.push(review.id);
    }

    return { remindedCount: reminded.length, suppressed };
  },

  /** Escalate a review that is overdue past the reminder cap. */
  'review.escalate_overdue': async (_payload, ctx) => {
    const overdue = await ctx.db.screeningReview.findMany({
      where: { state: 'ASSIGNED', dueAt: { lte: ctx.now } },
      include: { reviewer: true, screening: { include: { candidate: true } } },
      take: 100,
    });

    let raised = 0;
    const keep: string[] = [];

    for (const review of overdue) {
      const hoursLate = hoursBetween(review.dueAt, ctx.now);
      const dedupeKey = `review:overdue:${review.id}`;
      keep.push(dedupeKey);

      const result = await raiseAttention(
        ctx.db,
        {
          dedupeKey,
          category: 'review.overdue',
          severity: hoursLate > 48 ? 'HIGH' : 'MEDIUM',
          title: `${review.reviewer.name} is ${hoursLate}h late reviewing ${review.screening.reference}`,
          blocker: `Due ${hoursLate}h ago and still not submitted.`,
          impact: `${review.screening.candidate.fullName} cannot be qualified or rejected until this review lands.`,
          nextAction:
            review.remindersSent >= REMINDER_POLICY.maxReminders
              ? 'Reminders are exhausted. Reassign the review to another operator.'
              : 'Chase the reviewer, or reassign the review.',
          ownerId: review.reviewerId,
          dueAt: review.dueAt,
          screeningId: review.screeningId,
          candidateId: review.screening.candidateId,
          metadata: { hoursLate, remindersSent: review.remindersSent },
        },
        { now: ctx.now },
      );
      if (result.created) raised += 1;
    }

    // Anything that is no longer overdue resolves itself.
    const stale = await ctx.db.attentionItem.findMany({
      where: {
        status: 'OPEN',
        category: 'review.overdue',
        dedupeKey: { notIn: keep.length ? keep : ['__none__'] },
      },
      select: { dedupeKey: true },
    });
    for (const item of stale) {
      await resolveIfPresent(ctx.db, item.dedupeKey, 'The review is no longer overdue.', {
        now: ctx.now,
      });
    }

    return { escalated: raised, resolved: stale.length, overdueCount: overdue.length };
  },

  // -------------------------------------------------------------------------
  // Qualification and readiness
  // -------------------------------------------------------------------------

  /** A qualification was granted: open onboarding for the new expert. */
  'qualification.apply': async (payload, ctx) => {
    const schema = z.object({ qualificationId: z.string().min(1) });
    const { qualificationId } = parse(schema, payload, 'qualification.apply');

    const qualification = await ctx.db.qualification.findUnique({
      where: { id: qualificationId },
      include: { expert: { include: { onboardingCase: true } }, domain: true },
    });
    if (!qualification) return { applied: false, skipped: 'qualification no longer exists' };
    if (qualification.status !== 'ACTIVE') {
      return { applied: false, skipped: `qualification is ${qualification.status}` };
    }

    if (qualification.expert.onboardingCase) {
      return { applied: false, skipped: 'the expert already has an onboarding case' };
    }

    await ensureOnboardingCase(ctx.db, qualification.expertId);
    const onboardingCase = await getOnboardingCase(ctx.db, qualification.expertId);
    const outstanding = outstandingRequiredItems(onboardingCase.items);

    const portal = await issuePortalToken(ctx.db, {
      expertId: qualification.expertId,
      purpose: 'ONBOARDING',
    });
    const rendered = renderOnboardingStartEmail({
      expertName: qualification.expert.fullName,
      portalUrl: portal.url,
      outstandingItems: outstanding.map((item) => item.label),
    });
    const message = await queueExpertMessage(ctx.db, {
      expertId: qualification.expertId,
      kind: 'OPERATIONAL',
      subject: rendered.subject,
      bodyText: rendered.bodyText,
      template: 'onboarding.start',
      relatedType: 'qualification',
      relatedId: qualification.id,
      devPortalUrl: portal.url,
    });

    return {
      applied: true,
      onboardingCaseId: onboardingCase.id,
      outboxMessageId: message.messageId,
      skipped: message.skippedReason,
    };
  },

  /**
   * Recheck whether an expert can now be staffed on anything they accepted.
   *
   * Reads live state rather than trusting the event that scheduled it, so a
   * delayed job reaches the right conclusion.
   */
  'readiness.recheck': async (payload, ctx) => {
    const { expertId } = parse(expertPayload, payload, 'readiness.recheck');

    const expert = await ctx.db.expert.findUnique({ where: { id: expertId } });
    if (!expert) return { rechecked: false, skipped: 'expert no longer exists' };

    const accepted = await ctx.db.invitation.findMany({
      where: { expertId, status: 'ACCEPTED' },
      include: { project: true },
    });

    const ready: string[] = [];
    const blocked: Array<{ projectId: string; reason: string }> = [];

    for (const invitation of accepted) {
      const blocker = await readinessBlocker(ctx.db, invitation.projectId, expertId);
      const dedupeKey = `staffing:blocked:${invitation.projectId}:${expertId}`;

      if (blocker) {
        blocked.push({ projectId: invitation.projectId, reason: blocker });
        await raiseAttention(
          ctx.db,
          {
            dedupeKey,
            category: 'staffing.blocked_expert',
            severity: 'MEDIUM',
            title: `${expert.fullName} accepted ${invitation.project.code} but cannot be staffed`,
            blocker,
            impact: `A seat on ${invitation.project.code} is held open by someone who cannot take it.`,
            nextAction: 'Resolve the blocker shown, then propose the seat.',
            projectId: invitation.projectId,
            expertId,
          },
          { now: ctx.now },
        );
      } else {
        ready.push(invitation.projectId);
        await resolveIfPresent(ctx.db, dedupeKey, 'The expert is ready to be staffed.', {
          now: ctx.now,
        });

        await raiseAttention(
          ctx.db,
          {
            dedupeKey: `staffing:ready:${invitation.projectId}:${expertId}`,
            category: 'staffing.ready_to_assign',
            severity: 'MEDIUM',
            title: `${expert.fullName} is ready for a seat on ${invitation.project.code}`,
            blocker: 'Verified, available and qualified, but not yet proposed for a seat.',
            impact: `${invitation.project.code} still has unfilled seats while a ready expert waits.`,
            nextAction: 'Propose the seat, then confirm it.',
            projectId: invitation.projectId,
            expertId,
          },
          { now: ctx.now },
        );
      }
    }

    return { rechecked: true, readyFor: ready.length, blockedOn: blocked.length, blocked };
  },

  // -------------------------------------------------------------------------
  // Staffing
  // -------------------------------------------------------------------------

  'staffing.detect_gaps': async (_payload, ctx) => {
    const result = await detectStaffingGaps(ctx.db, { now: ctx.now });
    return {
      projectsChecked: result.projectsChecked,
      gapsFound: result.gapsFound,
      attentionRaised: result.attentionRaised,
      attentionResolved: result.attentionResolved,
    };
  },

  /** A seat was confirmed: clear the ready item and open project-start tasks. */
  'staffing.project_start_tasks': async (payload, ctx) => {
    const schema = z.object({ assignmentId: z.string().min(1) });
    const { assignmentId } = parse(schema, payload, 'staffing.project_start_tasks');

    const assignment = await ctx.db.assignment.findUnique({
      where: { id: assignmentId },
      include: { project: true, expert: true },
    });
    if (!assignment) return { created: false, skipped: 'assignment no longer exists' };
    if (assignment.status !== 'CONFIRMED') {
      return { created: false, skipped: `assignment is ${assignment.status}` };
    }

    await resolveIfPresent(
      ctx.db,
      `staffing:ready:${assignment.projectId}:${assignment.expertId}`,
      'The expert was staffed.',
      { now: ctx.now },
    );
    await resolveIfPresent(
      ctx.db,
      `staffing:blocked:${assignment.projectId}:${assignment.expertId}`,
      'The expert was staffed.',
      { now: ctx.now },
    );

    // A confirmed seat with no work assigned within a week is worth flagging.
    const existingWork = await ctx.db.workItem.count({ where: { assignmentId } });
    if (existingWork === 0) {
      await raiseAttention(
        ctx.db,
        {
          dedupeKey: `delivery:no_work:${assignmentId}`,
          category: 'delivery.no_work_assigned',
          severity: 'LOW',
          title: `${assignment.expert.fullName} is staffed on ${assignment.project.code} with no work assigned`,
          blocker: 'The seat is confirmed but no work item exists yet.',
          impact: 'The expert is allocated but has nothing to do.',
          nextAction: 'Create a work item with instructions and a due date.',
          projectId: assignment.projectId,
          expertId: assignment.expertId,
          assignmentId,
        },
        { now: ctx.now },
      );
    }

    return { created: true, workItemsExisting: existingWork };
  },

  /**
   * Assemble replacement recommendations into a batch.
   *
   * The batch is created in DRAFT and goes nowhere until an operator approves
   * it. Nothing is contacted by this job.
   */
  'staffing.propose_replacements': async (payload, ctx) => {
    const { projectId } = parse(projectPayload, payload, 'staffing.propose_replacements');

    const gap = await computeProjectGap(ctx.db, projectId);
    if (gap.gap <= 0) {
      return { proposed: false, skipped: 'the seat was refilled before this ran' };
    }

    const existing = await ctx.db.outreachBatch.findFirst({
      where: {
        projectId,
        kind: 'REPLACEMENT',
        status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] },
      },
    });
    if (existing) {
      return { proposed: false, skipped: `batch ${existing.reference} is already open` };
    }

    const result = await buildReplacementBatch(ctx.db, SYSTEM_ACTOR, {
      projectId,
      reason: `Automatic replacement proposal: ${gap.gap} seat(s) unfilled on ${gap.project.code}.`,
    });

    if (!result.batch) {
      await raiseAttention(
        ctx.db,
        {
          dedupeKey: `staffing:no_replacements:${projectId}`,
          category: 'staffing.no_replacements',
          severity: 'HIGH',
          title: `No replacement candidates for ${gap.project.code}`,
          blocker: 'The latest match run produced nobody who is not already invited or assigned.',
          impact: `${gap.gap} seat(s) remain unfilled with nobody to approach.`,
          nextAction: 'Re-run matching with looser requirements, or open a sourcing campaign.',
          projectId,
        },
        { now: ctx.now },
      );
      return { proposed: false, recommendations: 0, attentionRaised: true };
    }

    await raiseAttention(
      ctx.db,
      {
        dedupeKey: `outreach:awaiting_approval:${result.batch.id}`,
        category: 'outreach.awaiting_approval',
        severity: 'HIGH',
        title: `Replacement batch ${result.batch.reference} needs approval`,
        blocker: `${result.recommendations} replacement(s) proposed for ${gap.project.code}. Nothing has been sent.`,
        impact: `${gap.gap} seat(s) stay unfilled until the batch is approved and dispatched.`,
        nextAction: 'Review the proposed recipients and approve or reject the batch.',
        projectId,
        metadata: { batchId: result.batch.id, recipients: result.recommendations },
      },
      { now: ctx.now },
    );

    return {
      proposed: true,
      batchId: result.batch.id,
      recommendations: result.recommendations,
      awaitingHumanApproval: true,
    };
  },

  'matching.run': async (payload, ctx) => {
    const { projectId, limit } = parse(matchingPayload, payload, 'matching.run');
    const run = await runMatching(ctx.db, SYSTEM_ACTOR, projectId, { limit, now: ctx.now });
    return { matchRunId: run.id, candidateCount: run.candidateCount };
  },

  // -------------------------------------------------------------------------
  // Delivery, support and payment
  // -------------------------------------------------------------------------

  /** Work was submitted: make sure somebody knows to review it. */
  'work.review_task': async (payload, ctx) => {
    const schema = z.object({ workItemId: z.string().min(1) });
    const { workItemId } = parse(schema, payload, 'work.review_task');

    const workItem = await ctx.db.workItem.findUnique({
      where: { id: workItemId },
      include: { expert: true, project: true },
    });
    if (!workItem) return { raised: false, skipped: 'work item no longer exists' };
    if (workItem.status !== 'SUBMITTED') {
      return { raised: false, skipped: `work item is ${workItem.status}` };
    }

    const result = await raiseAttention(
      ctx.db,
      {
        dedupeKey: `work:review:${workItemId}`,
        category: 'work.awaiting_review',
        severity: 'MEDIUM',
        title: `${workItem.reference} from ${workItem.expert.fullName} needs review`,
        blocker: `Revision ${workItem.currentRevision} was submitted and has not been reviewed.`,
        impact: 'The expert is blocked, and no payment can be prepared until the work is approved.',
        nextAction: 'Open the work item, read the submission, then approve or request a revision.',
        projectId: workItem.projectId,
        expertId: workItem.expertId,
        workItemId,
        dueAt: workItem.dueAt,
      },
      { now: ctx.now },
    );

    return { raised: result.created, attentionItemId: result.item.id };
  },

  /** Flag work that is past its due date and still not submitted. */
  'work.remind_overdue': async (_payload, ctx) => {
    const overdue = await ctx.db.workItem.findMany({
      where: {
        status: { in: ['ASSIGNED', 'REVISION_REQUESTED'] },
        dueAt: { lte: ctx.now },
      },
      include: { expert: true, project: true },
      take: 100,
    });

    let raised = 0;
    const keep: string[] = [];

    for (const workItem of overdue) {
      const dedupeKey = `work:overdue:${workItem.id}`;
      keep.push(dedupeKey);
      const result = await raiseAttention(
        ctx.db,
        {
          dedupeKey,
          category: 'work.overdue',
          severity: 'MEDIUM',
          title: `${workItem.reference} is overdue from ${workItem.expert.fullName}`,
          blocker: `Due ${hoursBetween(workItem.dueAt!, ctx.now)}h ago, still ${workItem.status}.`,
          impact: `Delivery on ${workItem.project.code} is slipping.`,
          nextAction: 'Contact the expert, or extend the due date if the scope changed.',
          projectId: workItem.projectId,
          expertId: workItem.expertId,
          workItemId: workItem.id,
          dueAt: workItem.dueAt,
        },
        { now: ctx.now },
      );
      if (result.created) raised += 1;
    }

    const stale = await ctx.db.attentionItem.findMany({
      where: {
        status: 'OPEN',
        category: 'work.overdue',
        dedupeKey: { notIn: keep.length ? keep : ['__none__'] },
      },
      select: { dedupeKey: true },
    });
    for (const item of stale) {
      await resolveIfPresent(ctx.db, item.dedupeKey, 'The work is no longer overdue.', {
        now: ctx.now,
      });
    }

    return { raised, resolved: stale.length, overdueCount: overdue.length };
  },

  /** Support requests that have blown their response target. */
  'support.check_response_sla': async (_payload, ctx) => {
    const breached = await ctx.db.supportRequest.findMany({
      where: {
        status: { in: ['OPEN', 'WAITING_ON_OPS'] },
        firstRespondedAt: null,
        responseDueAt: { lte: ctx.now },
      },
      include: { expert: true, project: true },
      take: 100,
    });

    let raised = 0;
    const keep: string[] = [];

    for (const request of breached) {
      const dedupeKey = `support:overdue:${request.id}`;
      keep.push(dedupeKey);
      const result = await raiseAttention(
        ctx.db,
        {
          dedupeKey,
          category: 'support.response_overdue',
          severity: request.blocksReadiness || request.blocksDelivery ? 'HIGH' : 'MEDIUM',
          title: `${request.reference} from ${request.expert.fullName} has had no reply`,
          blocker: `"${request.subject}" was raised ${hoursBetween(request.createdAt, ctx.now)}h ago with no response.`,
          impact:
            request.blocksReadiness || request.blocksDelivery
              ? 'This request is marked as blocking, so an expert cannot proceed.'
              : 'An expert is waiting on the operations team.',
          nextAction: 'Open the request and reply, or assign it to someone who can.',
          ownerId: request.ownerId,
          expertId: request.expertId,
          projectId: request.projectId,
          supportRequestId: request.id,
          dueAt: request.responseDueAt,
        },
        { now: ctx.now },
      );
      if (result.created) raised += 1;
    }

    const stale = await ctx.db.attentionItem.findMany({
      where: {
        status: 'OPEN',
        category: 'support.response_overdue',
        dedupeKey: { notIn: keep.length ? keep : ['__none__'] },
      },
      select: { dedupeKey: true },
    });
    for (const item of stale) {
      await resolveIfPresent(ctx.db, item.dedupeKey, 'The request was answered or closed.', {
        now: ctx.now,
      });
    }

    return { raised, resolved: stale.length, breachedCount: breached.length };
  },

  /** Draft a payment item from approved work. Idempotent per approved review. */
  'payment.draft_from_approved_work': async (payload, ctx) => {
    const schema = z.object({ workItemId: z.string().min(1) });
    const { workItemId } = parse(schema, payload, 'payment.draft_from_approved_work');

    const workItem = await ctx.db.workItem.findUnique({ where: { id: workItemId } });
    if (!workItem) return { drafted: false, skipped: 'work item no longer exists' };
    if (workItem.status !== 'APPROVED') {
      return { drafted: false, skipped: `work item is ${workItem.status}` };
    }

    const result = await draftPaymentFromApprovedWork(ctx.db, SYSTEM_ACTOR, { workItemId });

    await resolveIfPresent(ctx.db, `work:review:${workItemId}`, 'The work was reviewed.', {
      now: ctx.now,
    });

    if (result.created && result.discrepancies.length > 0) {
      await raiseAttention(
        ctx.db,
        {
          dedupeKey: `payment:discrepancy:${result.item.id}`,
          category: 'payment.discrepancy',
          severity: 'MEDIUM',
          title: `Payment ${result.item.reference} has ${result.discrepancies.length} discrepancy flag(s)`,
          blocker: result.discrepancies.map((d) => d.message).join(' '),
          impact: 'The item cannot enter a payment batch until the difference is explained.',
          nextAction: 'Review the flags and record an explanation, or correct the item.',
          projectId: result.item.projectId,
          expertId: result.item.expertId,
          metadata: {
            paymentItemId: result.item.id,
            codes: result.discrepancies.map((d) => d.code),
          },
        },
        { now: ctx.now },
      );
    }

    return {
      drafted: result.created,
      paymentItemId: result.item.id,
      idempotentHit: !result.created,
      discrepancies: result.discrepancies.length,
    };
  },

  // -------------------------------------------------------------------------
  // Cross-cutting
  // -------------------------------------------------------------------------

  /** Open offboarding for everyone still staffed on a closing project. */
  'project.offboarding_tasks': async (payload, ctx) => {
    const { projectId } = parse(projectPayload, payload, 'project.offboarding_tasks');

    const project = await ctx.db.project.findUnique({ where: { id: projectId } });
    if (!project) return { opened: false, skipped: 'project no longer exists' };
    if (project.status !== 'CLOSED' && project.status !== 'CANCELLED') {
      return { opened: false, skipped: `project is ${project.status}` };
    }

    const result = await openProjectOffboarding(ctx.db, SYSTEM_ACTOR, projectId);
    return { opened: true, ...result };
  },

  /** The periodic sweep that keeps the attention queue honest. */
  'attention.sweep': async (_payload, ctx) => {
    const gaps = await detectStaffingGaps(ctx.db, { now: ctx.now });

    // Duplicate-person flags waiting on a human.
    const openDuplicates = await ctx.db.duplicateFlag.findMany({
      where: { status: 'OPEN' },
      include: { candidate: true },
      take: 100,
    });
    let duplicatesRaised = 0;
    for (const flag of openDuplicates) {
      const result = await raiseAttention(
        ctx.db,
        {
          dedupeKey: `duplicate:${flag.id}`,
          category: 'candidate.duplicate',
          severity: flag.score >= 90 ? 'HIGH' : 'MEDIUM',
          title: `${flag.candidate.fullName} may already exist`,
          blocker: flag.reason,
          impact: 'The candidate is on hold and cannot be screened until this is settled.',
          nextAction: 'Compare the two records and confirm whether they are the same person.',
          candidateId: flag.candidateId,
          metadata: { flagId: flag.id, score: flag.score },
        },
        { now: ctx.now },
      );
      if (result.created) duplicatesRaised += 1;
    }

    // Reviewer conflicts waiting on an authorised operator.
    const conflicts = await ctx.db.reviewConflict.findMany({
      where: { status: 'OPEN' },
      include: { screening: { include: { candidate: true } } },
      take: 100,
    });
    let conflictsRaised = 0;
    for (const conflict of conflicts) {
      const result = await raiseAttention(
        ctx.db,
        {
          dedupeKey: `conflict:${conflict.id}`,
          category: 'screening.review_conflict',
          severity: 'HIGH',
          title: `Reviewers disagree on ${conflict.screening.reference}`,
          blocker: conflict.summary,
          impact: `${conflict.screening.candidate.fullName} cannot be qualified or rejected while reviewers disagree.`,
          nextAction:
            'Read both reviews and record a resolution. The system will not break the tie.',
          screeningId: conflict.screeningId,
          candidateId: conflict.screening.candidateId,
        },
        { now: ctx.now },
      );
      if (result.created) conflictsRaised += 1;
    }

    // Qualifications flagged for re-review after a requirement change.
    const rereviews = await ctx.db.qualification.findMany({
      where: { status: 'NEEDS_REREVIEW' },
      include: { expert: true, domain: true },
      take: 100,
    });
    let rereviewsRaised = 0;
    for (const qualification of rereviews) {
      const result = await raiseAttention(
        ctx.db,
        {
          dedupeKey: `qualification:rereview:${qualification.id}`,
          category: 'qualification.needs_rereview',
          severity: 'MEDIUM',
          title: `${qualification.expert.fullName}'s ${qualification.domain.name} qualification needs re-review`,
          blocker: qualification.rereviewReason ?? 'A project raised its qualification bar.',
          impact:
            'The expert keeps their existing qualification, but cannot be staffed on projects requiring the newer rubric.',
          nextAction:
            'Confirm the qualification still stands, or mark it superseded and re-screen.',
          expertId: qualification.expertId,
          metadata: { qualificationId: qualification.id },
        },
        { now: ctx.now },
      );
      if (result.created) rereviewsRaised += 1;
    }

    // Outreach batches waiting on approval.
    const pendingBatches = await ctx.db.outreachBatch.findMany({
      where: { status: 'PENDING_APPROVAL' },
      include: { project: true, items: true },
      take: 50,
    });
    let batchesRaised = 0;
    for (const batch of pendingBatches) {
      const result = await raiseAttention(
        ctx.db,
        {
          dedupeKey: `outreach:awaiting_approval:${batch.id}`,
          category: 'outreach.awaiting_approval',
          severity: 'HIGH',
          title: `Outreach batch ${batch.reference} needs approval`,
          blocker: `${batch.items.length} recipient(s) proposed. Nothing has been sent.`,
          impact: batch.project
            ? `${batch.project.code} stays short until this batch goes out.`
            : 'Recruiting outreach is paused until this batch is decided.',
          nextAction: 'Review the recipients and approve or reject the batch.',
          projectId: batch.projectId,
          metadata: { batchId: batch.id, recipients: batch.items.length },
        },
        { now: ctx.now },
      );
      if (result.created) batchesRaised += 1;
    }

    // Payment batches waiting on approval.
    const pendingPayments = await ctx.db.paymentBatch.findMany({
      where: { status: 'PENDING_APPROVAL' },
      take: 50,
    });
    let paymentsRaised = 0;
    for (const batch of pendingPayments) {
      const result = await raiseAttention(
        ctx.db,
        {
          dedupeKey: `payment:awaiting_approval:${batch.id}`,
          category: 'payment.awaiting_approval',
          severity: 'MEDIUM',
          title: `Payment batch ${batch.reference} needs approval`,
          blocker: `${batch.itemCount} item(s) totalling ${(batch.totalMinor / 100).toFixed(2)} ${batch.currency}.`,
          impact: 'Experts are waiting on the finance handoff.',
          nextAction:
            'A different operator from the one who created it must review and approve the batch.',
          paymentBatchId: batch.id,
        },
        { now: ctx.now },
      );
      if (result.created) paymentsRaised += 1;
    }

    return {
      staffingGaps: gaps.gapsFound,
      staffingRaised: gaps.attentionRaised,
      staffingResolved: gaps.attentionResolved,
      duplicatesRaised,
      conflictsRaised,
      rereviewsRaised,
      batchesRaised,
      paymentsRaised,
    };
  },

  'outbox.dispatch': async (_payload, ctx) => {
    const result = await dispatchQueuedMessages(ctx.db, { now: ctx.now });
    return { attempted: result.attempted, delivered: result.delivered, simulated: true };
  },

  'maintenance.sweep': async (payload, ctx) => {
    const { pruneJobsOlderThanDays = 7 } = parse(sweepPayload, payload, 'maintenance.sweep');
    const sessions = await purgeExpiredSessions(ctx.db, ctx.now);
    const cutoff = new Date(ctx.now.getTime() - pruneJobsOlderThanDays * 86_400_000);
    const prunedJobs = await pruneFinishedJobs(ctx.db, cutoff);

    // Expired candidate portal artefacts, mirroring the expert ones.
    const candidateTokens = await ctx.db.candidatePortalToken.deleteMany({
      where: { expiresAt: { lte: ctx.now }, usedAt: null },
    });
    const candidateSessions = await ctx.db.candidatePortalSession.deleteMany({
      where: { expiresAt: { lte: ctx.now } },
    });

    // Sign-in attempts stop being evidence once they are well past the lockout
    // window; heartbeats from workers that are long gone stop being news.
    const loginAttempts = await pruneLoginAttempts(ctx.db, ctx.now);
    const staleWorkers = await pruneWorkerHeartbeats(
      ctx.db,
      new Date(ctx.now.getTime() - 7 * 86_400_000),
    );

    return {
      ...sessions,
      loginAttempts,
      staleWorkers,
      prunedJobs,
      candidateTokens: candidateTokens.count,
      candidateSessions: candidateSessions.count,
    };
  },
};

/**
 * Handler overrides, used only by tests.
 *
 * Ownership and lease behaviour has to be exercised with a handler that can be
 * made slow or made to block on demand, which no real handler can be. The
 * override table is separate from `HANDLERS` so a test cannot accidentally
 * leave a production handler replaced, and `unregisterTestHandler` restores the
 * real one.
 */
const TEST_OVERRIDES = new Map<string, JobHandler>();

export function registerTestHandler(type: string, handler: JobHandler): void {
  TEST_OVERRIDES.set(type, handler);
}

export function unregisterTestHandler(type: string): void {
  TEST_OVERRIDES.delete(type);
}

export function handlerFor(type: string): JobHandler | null {
  return (
    TEST_OVERRIDES.get(type) ?? (HANDLERS as Record<string, JobHandler | undefined>)[type] ?? null
  );
}

export function workerConfig() {
  const env = getEnv();
  return {
    name: env.WORKER_NAME,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    batchSize: env.WORKER_BATCH_SIZE,
    lockTimeoutSeconds: env.WORKER_LOCK_TIMEOUT_SECONDS,
  };
}

export { openOffboarding };
