import { z } from 'zod';
import { type Db, type Transactor } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { badRequest } from '@/lib/errors';
import { SYSTEM_ACTOR } from '@/server/services/activity';
import { purgeExpiredSessions } from '@/server/services/auth';
import {
  expireOverdueInvitations,
  remindPendingInvitations,
  sendInvitation,
} from '@/server/services/invitations';
import { pruneFinishedJobs, type JobType } from '@/server/services/jobs';
import { runMatching } from '@/server/services/matching';
import {
  ensureOnboardingCase,
  findStalledOnboarding,
  getOnboardingCase,
  outstandingRequiredItems,
} from '@/server/services/onboarding';
import { dispatchQueuedMessages, queueMessage } from '@/server/services/outbox';
import { issuePortalToken } from '@/server/services/portal-access';
import { renderOnboardingNudgeEmail, renderOnboardingStartEmail } from '@/server/email/templates';
import { recordActivity } from '@/server/services/activity';

/**
 * Job handlers.
 *
 * Each handler is a thin wrapper that parses its payload and calls the SAME
 * business service the HTTP layer calls. No business rule is implemented here.
 */
export interface HandlerContext {
  db: Db;
  client: Transactor;
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
      `Invalid payload for job "${jobType}": ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  }
  return result.data;
}

export const HANDLERS: Record<JobType, JobHandler> = {
  /** Render the invitation email into the simulated outbox and mark it SENT. */
  'invitation.send': async (payload, ctx) => {
    const { invitationId } = parse(invitationPayload, payload, 'invitation.send');
    const result = await sendInvitation(ctx.db, SYSTEM_ACTOR, invitationId);
    return result
      ? { sent: true, outboxMessageId: result.outboxMessageId }
      : { sent: false, reason: 'invitation was no longer in DRAFT' };
  },

  /** Single reminder for invitations still open past the threshold. */
  'invitation.remind': async (payload, ctx) => {
    const options = parse(remindPayload, payload, 'invitation.remind');
    const result = await remindPendingInvitations(ctx.db, { ...options, now: ctx.now });
    return { remindedCount: result.remindedCount, invitationIds: result.invitationIds };
  },

  /** Close invitations whose response deadline has passed. */
  'invitation.expire': async (_payload, ctx) => {
    const result = await expireOverdueInvitations(ctx.db, { now: ctx.now });
    return { expiredCount: result.expiredCount, invitationIds: result.invitationIds };
  },

  /** Open the onboarding checklist and email the expert a portal link. */
  'onboarding.start': async (payload, ctx) => {
    const { expertId } = parse(expertPayload, payload, 'onboarding.start');
    const expert = await ctx.db.expert.findUnique({ where: { id: expertId } });
    if (!expert) return { started: false, reason: 'expert no longer exists' };

    await ensureOnboardingCase(ctx.db, expertId);
    const onboardingCase = await getOnboardingCase(ctx.db, expertId);
    const outstanding = outstandingRequiredItems(onboardingCase.items);
    if (outstanding.length === 0) {
      return { started: true, emailed: false, reason: 'checklist already complete' };
    }

    const portal = await issuePortalToken(ctx.db, { expertId, purpose: 'ONBOARDING' });
    const rendered = renderOnboardingStartEmail({
      expertName: expert.fullName,
      portalUrl: portal.url,
      outstandingItems: outstanding.map((item) => item.label),
    });
    const message = await queueMessage(ctx.db, {
      toEmail: expert.email,
      toName: expert.fullName,
      subject: rendered.subject,
      bodyText: rendered.bodyText,
      template: 'onboarding.start',
      relatedType: 'onboarding',
      relatedId: onboardingCase.id,
      expertId,
      devPortalUrl: portal.url,
    });
    return { started: true, emailed: true, outboxMessageId: message.id };
  },

  /** Nudge experts whose checklist is stalled. One nudge per interval. */
  'onboarding.nudge': async (payload, ctx) => {
    const { nudgeAfterHours = 24 } = parse(nudgePayload, payload, 'onboarding.nudge');
    const stalled = await findStalledOnboarding(ctx.db, { nudgeAfterHours, now: ctx.now });

    const nudged: string[] = [];
    for (const onboardingCase of stalled) {
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
      await queueMessage(ctx.db, {
        toEmail: onboardingCase.expert.email,
        toName: onboardingCase.expert.fullName,
        subject: rendered.subject,
        bodyText: rendered.bodyText,
        template: 'onboarding.nudge',
        relatedType: 'onboarding',
        relatedId: onboardingCase.id,
        expertId: onboardingCase.expertId,
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

    return { nudgedCount: nudged.length, expertIds: nudged };
  },

  /**
   * NOT IMPLEMENTED. Reserved for a future integration that notifies a
   * client-side system of a verification decision.
   *
   * It is a declared no-op rather than a missing type, so the shape of the
   * integration stays visible without pretending it exists. The expert-facing
   * decision email is queued by the verification endpoint, so nothing is lost.
   */
  'onboarding.notify_decision': async (payload) => {
    const { expertId } = parse(expertPayload, payload, 'onboarding.notify_decision');
    return { notified: false, expertId, reason: 'not implemented in this slice' };
  },

  /**
   * NOT IMPLEMENTED. Reserved for a future integration that pushes a confirmed
   * assignment to an external scheduling or resourcing system.
   *
   * It is a declared no-op rather than a missing type, so the shape of the
   * integration stays visible without pretending it exists. The expert-facing
   * confirmation email is queued by the staffing service, so nothing is lost.
   */
  'assignment.notify': async (payload) => {
    const schema = z.object({ assignmentId: z.string().min(1) });
    const { assignmentId } = parse(schema, payload, 'assignment.notify');
    return { notified: false, assignmentId, reason: 'not implemented in this slice' };
  },

  /** Re-run matching in the background, e.g. after a bulk expert import. */
  'matching.run': async (payload, ctx) => {
    const { projectId, limit } = parse(matchingPayload, payload, 'matching.run');
    const run = await runMatching(ctx.db, SYSTEM_ACTOR, projectId, { limit, now: ctx.now });
    return { matchRunId: run.id, candidateCount: run.candidateCount };
  },

  /** Simulated delivery: flip QUEUED outbox rows to SENT. */
  'outbox.dispatch': async (_payload, ctx) => {
    const result = await dispatchQueuedMessages(ctx.db, { now: ctx.now });
    return { attempted: result.attempted, delivered: result.delivered, simulated: true };
  },

  /** Housekeeping: expired sessions, old finished jobs. */
  'maintenance.sweep': async (payload, ctx) => {
    const { pruneJobsOlderThanDays = 7 } = parse(sweepPayload, payload, 'maintenance.sweep');
    const sessions = await purgeExpiredSessions(ctx.db, ctx.now);
    const cutoff = new Date(ctx.now.getTime() - pruneJobsOlderThanDays * 86_400_000);
    const prunedJobs = await pruneFinishedJobs(ctx.db, cutoff);
    return { ...sessions, prunedJobs };
  },
};

export function handlerFor(type: string): JobHandler | null {
  return (HANDLERS as Record<string, JobHandler | undefined>)[type] ?? null;
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
