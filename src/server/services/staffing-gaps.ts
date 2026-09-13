import { type Project } from '@prisma/client';
import { type Db, type MaybeTransactor, withTransaction } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { invalidState, notFound } from '@/lib/errors';
import { daysFromNow } from '@/lib/time';
import { type Actor, recordActivity } from './activity';
import { raiseAttention, resolveIfPresent } from './attention';
import { enqueueJob } from './jobs';
import { advanceProjectStatus } from './projects';
import { checkQualificationEligibility } from './qualifications';
import { lockProject, releaseAssignmentWithin } from './staffing';

/**
 * Staffing-gap detection.
 *
 * This is the job that was missing from the original build: something has to
 * notice that a project will not be staffed in time and say so, rather than
 * waiting for an operator to spot it. It reads current state every run and is
 * safe to run as often as you like.
 */
export interface ProjectGap {
  project: Project;
  seatsRequested: number;
  seatsFilled: number;
  seatsProposed: number;
  /** Accepted invitations not yet turned into a confirmed seat. */
  acceptedNotStaffed: number;
  openInvitations: number;
  gap: number;
  /** Experts who could plausibly close the gap, with why they cannot yet. */
  blockedReady: Array<{ expertId: string; fullName: string; reason: string }>;
  /** True when there is nobody left in the funnel to close the gap. */
  needsSourcing: boolean;
  daysUntilStart: number | null;
}

/**
 * Compute the gap for one project.
 *
 * "Gap" is seats still needed after counting everything already in flight, so a
 * project with three open seats and three accepted experts is not reported as
 * short even though nobody is confirmed yet.
 */
export async function computeProjectGap(db: Db, projectId: string): Promise<ProjectGap> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('Project not found.');

  const [assignments, invitations] = await Promise.all([
    db.assignment.findMany({
      where: { projectId, status: { in: ['PROPOSED', 'CONFIRMED', 'COMPLETED'] } },
      select: { status: true, expertId: true },
    }),
    db.invitation.findMany({
      where: { projectId, status: { in: ['DRAFT', 'SENT', 'ACCEPTED'] } },
      include: { expert: { select: { id: true, fullName: true, status: true } } },
    }),
  ]);

  const seatsFilled = assignments.filter(
    (a) => a.status === 'CONFIRMED' || a.status === 'COMPLETED',
  ).length;
  const seatsProposed = assignments.filter((a) => a.status === 'PROPOSED').length;
  const assignedExpertIds = new Set(assignments.map((a) => a.expertId));

  const accepted = invitations.filter((i) => i.status === 'ACCEPTED');
  const acceptedNotStaffed = accepted.filter((i) => !assignedExpertIds.has(i.expertId)).length;
  const openInvitations = invitations.filter(
    (i) => i.status === 'DRAFT' || i.status === 'SENT',
  ).length;

  // Everything already working towards a seat.
  const inFlight = seatsFilled + seatsProposed + acceptedNotStaffed + openInvitations;
  const gap = Math.max(0, project.seatsRequested - inFlight);

  // For accepted experts not yet staffed, say precisely what is blocking them.
  const blockedReady: ProjectGap['blockedReady'] = [];
  for (const invitation of accepted) {
    if (assignedExpertIds.has(invitation.expertId)) continue;

    const reason = await readinessBlocker(db, projectId, invitation.expertId);
    if (reason) {
      blockedReady.push({
        expertId: invitation.expertId,
        fullName: invitation.expert.fullName,
        reason,
      });
    }
  }

  const daysUntilStart = project.startDate
    ? Math.ceil((project.startDate.getTime() - clockNow().getTime()) / 86_400_000)
    : null;

  return {
    project,
    seatsRequested: project.seatsRequested,
    seatsFilled,
    seatsProposed,
    acceptedNotStaffed,
    openInvitations,
    gap,
    blockedReady,
    // Nothing in the funnel and seats still open means recruiting, not chasing.
    needsSourcing: gap > 0 && openInvitations === 0 && acceptedNotStaffed === 0,
    daysUntilStart,
  };
}

/**
 * Why can this accepted expert not take a seat right now?
 *
 * Returns the single most important blocker, in the order an operator would
 * actually work through them. Null means they are ready.
 */
export async function readinessBlocker(
  db: Db,
  projectId: string,
  expertId: string,
): Promise<string | null> {
  const expert = await db.expert.findUnique({
    where: { id: expertId },
    include: { onboardingCase: true },
  });
  if (!expert) return 'Expert record is missing';
  if (expert.status === 'ARCHIVED') return 'Expert is archived';

  const eligibility = await checkQualificationEligibility(db, projectId, expertId);
  if (!eligibility.eligible) return `Qualification: ${eligibility.reason}`;

  if (expert.status !== 'VERIFIED') {
    if (expert.onboardingCase?.status === 'SUBMITTED') return 'Waiting on operator verification';
    if (expert.onboardingCase?.status === 'REJECTED') return 'Onboarding was returned for changes';
    return `Onboarding incomplete (expert is ${expert.status})`;
  }

  const blockingSupport = await db.supportRequest.findFirst({
    where: {
      expertId,
      blocksReadiness: true,
      status: { in: ['OPEN', 'WAITING_ON_EXPERT', 'WAITING_ON_OPS'] },
    },
  });
  if (blockingSupport) {
    return `Blocked by support request ${blockingSupport.reference}: ${blockingSupport.subject}`;
  }

  const windows = await db.availabilityWindow.findMany({
    where: { expertId, OR: [{ projectId }, { projectId: null }] },
  });
  if (windows.length === 0) return 'No availability declared';

  return null;
}

export interface GapSweepResult {
  projectsChecked: number;
  gapsFound: number;
  attentionRaised: number;
  attentionResolved: number;
  gaps: ProjectGap[];
}

/**
 * AUTOMATED. Scan open projects and surface staffing shortfalls.
 *
 * Raises one attention item per project, keyed on the project, so running every
 * ten minutes produces one item rather than one per run. Clears itself the
 * moment the gap closes.
 */
export async function detectStaffingGaps(
  db: Db,
  options: { now?: Date } = {},
): Promise<GapSweepResult> {
  const at = options.now ?? clockNow();

  const projects = await db.project.findMany({
    where: { status: { in: ['MATCHING', 'INVITING', 'STAFFING'] } },
    select: { id: true },
  });

  let attentionRaised = 0;
  let attentionResolved = 0;
  const gaps: ProjectGap[] = [];

  for (const { id } of projects) {
    const gap = await computeProjectGap(db, id);
    const dedupeKey = `staffing:gap:${id}`;

    if (gap.gap > 0) {
      gaps.push(gap);
      const urgent = gap.daysUntilStart !== null && gap.daysUntilStart <= 14;
      const result = await raiseAttention(
        db,
        {
          dedupeKey,
          category: 'staffing.gap',
          severity: urgent ? 'HIGH' : 'MEDIUM',
          title: `${gap.project.code} is ${gap.gap} expert(s) short`,
          blocker: `${gap.seatsFilled}/${gap.seatsRequested} seats confirmed, with ${gap.openInvitations} invitation(s) out and ${gap.acceptedNotStaffed} accepted expert(s) not yet staffed.`,
          impact:
            gap.daysUntilStart === null
              ? 'The project cannot start until the remaining seats are filled.'
              : `The project starts in ${gap.daysUntilStart} day(s) and will be understaffed.`,
          nextAction: gap.needsSourcing
            ? 'Nobody is in the funnel. Open a sourcing campaign or widen the project requirements.'
            : 'Review the ranked candidates and send more invitations, or unblock the accepted experts.',
          projectId: gap.project.id,
          dueAt: gap.project.startDate,
          metadata: {
            gap: gap.gap,
            seatsFilled: gap.seatsFilled,
            seatsRequested: gap.seatsRequested,
            needsSourcing: gap.needsSourcing,
            blockedReady: gap.blockedReady,
          },
        },
        { now: at },
      );
      if (result.created) attentionRaised += 1;
    } else {
      if (await resolveIfPresent(db, dedupeKey, 'The staffing gap closed.', { now: at })) {
        attentionResolved += 1;
      }
      // A withdrawal is only actionable while the seat is still short.
      const withdrawals = await db.attentionItem.findMany({
        where: { status: 'OPEN', category: 'staffing.withdrawal', projectId: id },
        select: { dedupeKey: true },
      });
      for (const item of withdrawals) {
        if (
          await resolveIfPresent(db, item.dedupeKey, 'The vacated seat was refilled.', { now: at })
        ) {
          attentionResolved += 1;
        }
      }
    }

    // Each blocked-but-accepted expert is its own actionable item.
    for (const blocked of gap.blockedReady) {
      const blockedKey = `staffing:blocked:${id}:${blocked.expertId}`;
      const result = await raiseAttention(
        db,
        {
          dedupeKey: blockedKey,
          category: 'staffing.blocked_expert',
          severity: 'MEDIUM',
          title: `${blocked.fullName} accepted ${gap.project.code} but cannot be staffed`,
          blocker: blocked.reason,
          impact: `A seat on ${gap.project.code} is being held open by someone who cannot take it yet.`,
          nextAction: blocked.reason.includes('verification')
            ? 'Review their onboarding submission in the verification queue.'
            : blocked.reason.includes('availability')
              ? 'Ask the expert to declare availability in their portal.'
              : 'Resolve the blocker shown, then propose the seat.',
          projectId: gap.project.id,
          expertId: blocked.expertId,
          metadata: { reason: blocked.reason },
        },
        { now: at },
      );
      if (result.created) attentionRaised += 1;
    }

    // Clear items for experts who are no longer blocked.
    const stillBlocked = new Set(gap.blockedReady.map((b) => b.expertId));
    const openBlocked = await db.attentionItem.findMany({
      where: { status: 'OPEN', category: 'staffing.blocked_expert', projectId: id },
      select: { dedupeKey: true, expertId: true },
    });
    for (const item of openBlocked) {
      if (item.expertId && !stillBlocked.has(item.expertId)) {
        if (
          await resolveIfPresent(db, item.dedupeKey, 'The expert is no longer blocked.', {
            now: at,
          })
        ) {
          attentionResolved += 1;
        }
      }
    }
  }

  // A project that leaves the scanned statuses (closed, cancelled, or filled
  // and now ACTIVE) is never visited again by the loop above, so its items
  // would stay open forever. Close them here rather than orphaning them.
  const scannedIds = new Set(projects.map((project) => project.id));
  const orphaned = await db.attentionItem.findMany({
    where: {
      status: 'OPEN',
      category: { in: ['staffing.gap', 'staffing.blocked_expert', 'staffing.withdrawal'] },
      projectId: { notIn: scannedIds.size > 0 ? [...scannedIds] : ['__none__'] },
    },
    select: { dedupeKey: true },
  });
  for (const item of orphaned) {
    if (
      await resolveIfPresent(db, item.dedupeKey, 'The project is no longer open for staffing.', {
        now: at,
      })
    ) {
      attentionResolved += 1;
    }
  }

  return {
    projectsChecked: projects.length,
    gapsFound: gaps.length,
    attentionRaised,
    attentionResolved,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// Withdrawal and replacement
// ---------------------------------------------------------------------------

export interface WithdrawalResult {
  releasedAssignmentId: string | null;
  seatsFilled: number;
  gap: ProjectGap;
  /**
   * True when this project had already been withdrawn from and the call changed
   * nothing. A retried request, a double-click and a duplicate submit all land
   * here rather than producing a second set of effects.
   */
  alreadyWithdrawn: boolean;
  /**
   * Work that was still outstanding and has been cancelled, so the reminders
   * attached to it stop. Submitted, approved and paid work is never touched.
   */
  cancelledWorkItemIds: string[];
}

/** Work an expert can no longer be expected to deliver once they have left. */
const OUTSTANDING_WORK_STATUSES = ['DRAFT', 'ASSIGNED', 'REVISION_REQUESTED'] as const;

export interface WithdrawalInput {
  projectId: string;
  expertId: string;
  /** Optional. A withdrawal is valid without an explanation. */
  reason?: string | null;
}

/**
 * An expert steps off a project.
 *
 * One transaction covers the whole thing: the seat release, the withdrawn
 * invitation, the cancellation of work that can no longer be delivered, the
 * audit event, the attention item and the replacement job. Either all of it is
 * true afterwards or none of it is, so an interrupted request cannot leave a
 * released seat with no record of why.
 *
 * Three properties the callers depend on:
 *
 *  * **Scoped.** Withdrawal requires an accepted invitation or a live
 *    assignment on *that* project. Someone else's project, or a project this
 *    expert was never committed to, is refused rather than quietly audited.
 *  * **Idempotent.** The project row is locked first, so concurrent requests
 *    queue; the losers see the committed withdrawal and return it unchanged.
 *    Repeat clicks produce one audit event, one attention item and one job.
 *  * **Non-destructive.** Submitted, approved and paid work survives. Only
 *    work that was still waiting on this expert is cancelled.
 */
export async function recordWithdrawal(
  client: MaybeTransactor,
  actor: Actor,
  input: WithdrawalInput,
): Promise<WithdrawalResult> {
  const reason = (input.reason ?? '').trim().slice(0, 500);
  // `releaseAssignmentWithin` requires a reason for the audit trail, so an
  // unexplained withdrawal still says what happened, just not why.
  const releaseReason = reason
    ? `Expert withdrew: ${reason}`
    : 'Expert withdrew (no reason given).';

  return withTransaction(client, async (tx) => {
    const expert = await tx.expert.findUnique({ where: { id: input.expertId } });
    if (!expert) throw notFound('Expert not found.');

    // Everything below is read under this lock, so two concurrent withdrawals
    // for the same project cannot both believe they are the first.
    await lockProject(tx, input.projectId);
    const project = await tx.project.findUniqueOrThrow({ where: { id: input.projectId } });

    const invitation = await tx.invitation.findUnique({
      where: { projectId_expertId: { projectId: input.projectId, expertId: input.expertId } },
    });
    const assignment = await tx.assignment.findUnique({
      where: { projectId_expertId: { projectId: input.projectId, expertId: input.expertId } },
    });

    const activeAssignment =
      assignment && (assignment.status === 'PROPOSED' || assignment.status === 'CONFIRMED')
        ? assignment
        : null;
    const acceptedInvitation = invitation?.status === 'ACCEPTED' ? invitation : null;

    if (!activeAssignment && !acceptedInvitation) {
      // Either this is a repeat of a withdrawal that already happened, or the
      // expert has no standing on this project at all. The audit trail is what
      // tells the two apart.
      const prior = await tx.activityEvent.findFirst({
        where: {
          projectId: input.projectId,
          expertId: input.expertId,
          action: 'assignment.expert_withdrew',
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!prior) {
        throw invalidState(
          `${expert.fullName} has no accepted invitation or active assignment on ${project.code}, so there is nothing to withdraw from.`,
          { projectId: input.projectId, expertId: input.expertId },
        );
      }

      const gap = await computeProjectGap(tx, input.projectId);
      const metadata = (prior.metadata ?? {}) as { releasedAssignmentId?: string | null };
      return {
        releasedAssignmentId: metadata.releasedAssignmentId ?? null,
        seatsFilled: gap.seatsFilled,
        gap,
        alreadyWithdrawn: true,
        cancelledWorkItemIds: [],
      };
    }

    let releasedAssignmentId: string | null = null;
    let seatsFilled = project.seatsFilled;

    if (activeAssignment) {
      // Only the commitment on this project is released. Seats the expert holds
      // elsewhere are none of this call's business.
      const released = await releaseAssignmentWithin(tx, actor, activeAssignment.id, releaseReason);
      releasedAssignmentId = released.assignment.id;
      seatsFilled = released.seatsFilled;
    }

    // An accepted invitation is withdrawn too, so the funnel reflects reality.
    await tx.invitation.updateMany({
      where: { projectId: input.projectId, expertId: input.expertId, status: 'ACCEPTED' },
      data: { status: 'WITHDRAWN', withdrawReason: releaseReason, respondedAt: clockNow() },
    });

    // Work still waiting on this expert cannot be delivered by them, so it is
    // cancelled and its overdue reminders stop. Anything already submitted,
    // reviewed, approved or paid is left exactly as it is: the expert did that
    // work and the record of it has to survive their departure.
    const outstanding = await tx.workItem.findMany({
      where: {
        projectId: input.projectId,
        expertId: input.expertId,
        status: { in: [...OUTSTANDING_WORK_STATUSES] },
      },
      select: { id: true, reference: true },
    });
    const cancelledWorkItemIds = outstanding.map((item) => item.id);
    if (cancelledWorkItemIds.length > 0) {
      await tx.workItem.updateMany({
        where: {
          id: { in: cancelledWorkItemIds },
          status: { in: [...OUTSTANDING_WORK_STATUSES] },
        },
        data: { status: 'CANCELLED' },
      });
      for (const item of outstanding) {
        await resolveIfPresent(
          tx,
          `work:overdue:${item.id}`,
          'The expert withdrew, so this work item was cancelled.',
        );
      }
    }

    // Counted before the new event is written, so the key below identifies this
    // withdrawal and not merely this pairing: an expert who is re-staffed and
    // withdraws a second time gets a second replacement search.
    const priorWithdrawals = await tx.activityEvent.count({
      where: {
        projectId: input.projectId,
        expertId: input.expertId,
        action: 'assignment.expert_withdrew',
      },
    });

    await recordActivity(tx, {
      actor,
      entityType: 'assignment',
      entityId: activeAssignment?.id ?? assignment?.id ?? input.projectId,
      projectId: input.projectId,
      expertId: input.expertId,
      action: 'assignment.expert_withdrew',
      summary: `${expert.fullName} withdrew from ${project.code}`,
      metadata: {
        reason: reason || null,
        releasedAssignmentId,
        cancelledWorkItems: outstanding.map((item) => item.reference),
      },
    });

    // Anything that was true only because this person held the seat is no longer
    // true, so those items close rather than lingering as noise.
    for (const key of [
      releasedAssignmentId ? `delivery:no_work:${releasedAssignmentId}` : null,
      `staffing:ready:${input.projectId}:${input.expertId}`,
      `staffing:blocked:${input.projectId}:${input.expertId}`,
    ]) {
      if (key) await resolveIfPresent(tx, key, 'The expert withdrew from this project.');
    }

    const gap = await computeProjectGap(tx, input.projectId);
    const seatsUnfilled = Math.max(0, project.seatsRequested - seatsFilled);

    // A fully staffed project is ACTIVE, and an ACTIVE project accepts no
    // invitations. Without this, a withdrawal from a full project produced a
    // replacement batch that could never be dispatched: the shortage was
    // visible and unfixable. Returning it to STAFFING is the existing
    // transition for exactly this situation.
    //
    // The test is empty seats, not `gap`. `gap` counts everything already in
    // flight, an outstanding invitation included, so a withdrawal from a
    // project that still had an unanswered invitation out scored zero and the
    // project stayed ACTIVE holding an empty seat. ACTIVE is entered on
    // `seatsFilled >= seatsRequested`; it has to be left on the same measure,
    // or the two disagree and the project is stuck in whichever direction it
    // moved last.
    if (seatsUnfilled > 0) {
      await advanceProjectStatus(tx, actor, input.projectId, 'STAFFING');
    }

    await raiseAttention(tx, {
      dedupeKey: `staffing:withdrawal:${input.projectId}:${input.expertId}`,
      category: 'staffing.withdrawal',
      severity: 'HIGH',
      title: `${expert.fullName} withdrew from ${project.code}`,
      blocker: reason ? `Reason given: ${reason}` : 'No reason was given.',
      // Two different numbers, and the operator needs both: how many seats are
      // empty, and how much of that is already covered by someone who has been
      // asked but has not answered.
      impact:
        `${seatsUnfilled} seat(s) now unfilled on ${project.code}.` +
        (gap.gap < seatsUnfilled
          ? ` ${seatsUnfilled - gap.gap} is covered by outreach already sent.`
          : ''),
      nextAction: 'Review replacement recommendations and send an approved outreach batch.',
      projectId: input.projectId,
      expertId: input.expertId,
      dueAt: project.startDate,
      metadata: {
        reason: reason || null,
        gap: gap.gap,
        seatsUnfilled,
        cancelledWorkItems: outstanding.map((item) => item.reference),
      },
    });

    // Replacement recommendations are assembled by a job; they are never sent.
    // Dispatch waits on an operator approving the resulting batch.
    await enqueueJob(tx, {
      type: 'staffing.propose_replacements',
      payload: { projectId: input.projectId },
      priority: 20,
      // One key per withdrawal event. A retry that somehow reached this point
      // would collide with it rather than queue a second search.
      dedupeKey: `staffing.propose_replacements:${input.projectId}:${input.expertId}:${priorWithdrawals}`,
    });

    return {
      releasedAssignmentId,
      seatsFilled,
      gap,
      alreadyWithdrawn: false,
      cancelledWorkItemIds,
    };
  });
}

export interface ExpertCommitment {
  projectId: string;
  projectCode: string;
  projectTitle: string;
  clientName: string;
  startDate: Date | null;
  endDate: Date | null;
  /** Where this commitment sits: accepted but not yet given a seat, or holding one. */
  stage: 'ACCEPTED' | 'PROPOSED' | 'CONFIRMED';
  allocationHoursPerWeek: number | null;
  /** Work that would be cancelled by withdrawing now. */
  outstandingWorkItems: number;
  /** Work already submitted or approved, which a withdrawal keeps. */
  retainedWorkItems: number;
}

export interface WithdrawnCommitment {
  projectId: string;
  projectCode: string;
  projectTitle: string;
  withdrawnAt: Date | null;
  reason: string | null;
}

/**
 * What an expert is currently committed to, and what they have withdrawn from.
 *
 * This is the portal's view of its own withdrawal action: the live commitments
 * are the ones that can be withdrawn from, and the withdrawn list is what the
 * expert sees afterwards so the outcome is not invisible.
 */
export async function listExpertCommitments(
  db: Db,
  expertId: string,
): Promise<{ active: ExpertCommitment[]; withdrawn: WithdrawnCommitment[] }> {
  const [invitations, assignments, workItems] = await Promise.all([
    db.invitation.findMany({
      where: { expertId, status: { in: ['ACCEPTED', 'WITHDRAWN'] } },
      include: { project: true },
      orderBy: { respondedAt: 'desc' },
    }),
    db.assignment.findMany({
      where: { expertId, status: { in: ['PROPOSED', 'CONFIRMED'] } },
      include: { project: true },
    }),
    db.workItem.findMany({ where: { expertId }, select: { projectId: true, status: true } }),
  ]);

  const outstandingByProject = new Map<string, number>();
  const retainedByProject = new Map<string, number>();
  for (const item of workItems) {
    const bucket = (OUTSTANDING_WORK_STATUSES as readonly string[]).includes(item.status)
      ? outstandingByProject
      : item.status === 'CANCELLED'
        ? null
        : retainedByProject;
    if (bucket) bucket.set(item.projectId, (bucket.get(item.projectId) ?? 0) + 1);
  }

  const active: ExpertCommitment[] = [];
  const seen = new Set<string>();

  for (const assignment of assignments) {
    seen.add(assignment.projectId);
    active.push({
      projectId: assignment.projectId,
      projectCode: assignment.project.code,
      projectTitle: assignment.project.title,
      clientName: assignment.project.clientName,
      startDate: assignment.startDate ?? assignment.project.startDate,
      endDate: assignment.endDate ?? assignment.project.endDate,
      stage: assignment.status === 'CONFIRMED' ? 'CONFIRMED' : 'PROPOSED',
      allocationHoursPerWeek: assignment.allocationHoursPerWeek,
      outstandingWorkItems: outstandingByProject.get(assignment.projectId) ?? 0,
      retainedWorkItems: retainedByProject.get(assignment.projectId) ?? 0,
    });
  }

  for (const invitation of invitations) {
    if (invitation.status !== 'ACCEPTED') continue;
    if (seen.has(invitation.projectId)) continue;
    active.push({
      projectId: invitation.projectId,
      projectCode: invitation.project.code,
      projectTitle: invitation.project.title,
      clientName: invitation.project.clientName,
      startDate: invitation.project.startDate,
      endDate: invitation.project.endDate,
      stage: 'ACCEPTED',
      allocationHoursPerWeek: null,
      outstandingWorkItems: outstandingByProject.get(invitation.projectId) ?? 0,
      retainedWorkItems: retainedByProject.get(invitation.projectId) ?? 0,
    });
  }

  const withdrawn: WithdrawnCommitment[] = invitations
    .filter((invitation) => invitation.status === 'WITHDRAWN')
    .map((invitation) => ({
      projectId: invitation.projectId,
      projectCode: invitation.project.code,
      projectTitle: invitation.project.title,
      withdrawnAt: invitation.respondedAt,
      reason: invitation.withdrawReason,
    }));

  return { active, withdrawn };
}

export interface ReplacementRecommendation {
  expertId: string;
  fullName: string;
  headline: string;
  score: number;
  rationale: string;
  hourlyRateCents: number;
  currency: string;
}

/**
 * Suggest who could fill a vacated seat.
 *
 * Recommendations only. Nothing is contacted until an operator approves an
 * outreach batch built from this list.
 */
export async function recommendReplacements(
  db: Db,
  projectId: string,
  limit = 5,
): Promise<ReplacementRecommendation[]> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { requirements: { include: { skill: true } } },
  });
  if (!project) throw notFound('Project not found.');

  const latestRun = await db.matchRun.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    include: {
      candidates: {
        where: { excluded: false },
        orderBy: { rank: 'asc' },
        include: { expert: true },
      },
    },
  });

  if (!latestRun) return [];

  // Anyone whose story on this project is already written. `WITHDRAWN` and
  // `RELEASED` are here because of what this list is for: proposing a
  // replacement for a seat somebody just left. Without them the expert who
  // withdrew an hour ago comes back at the top of their own replacement list,
  // described as "qualified and ready", and an approved batch re-invites the
  // person who just said they could not do it. An operator who does want them
  // back can still invite them by hand from the project screen; what is wrong
  // is the system proposing it.
  const excluded = await db.invitation.findMany({
    where: { projectId, status: { in: ['DRAFT', 'SENT', 'ACCEPTED', 'WITHDRAWN'] } },
    select: { expertId: true },
  });
  const assigned = await db.assignment.findMany({
    where: { projectId, status: { in: ['PROPOSED', 'CONFIRMED', 'COMPLETED', 'RELEASED'] } },
    select: { expertId: true },
  });
  const skip = new Set([...excluded, ...assigned].map((row) => row.expertId));

  const recommendations: ReplacementRecommendation[] = [];
  for (const candidate of latestRun.candidates) {
    if (recommendations.length >= limit) break;
    if (skip.has(candidate.expertId)) continue;
    if (candidate.expert.status === 'ARCHIVED') continue;

    const eligibility = await checkQualificationEligibility(db, projectId, candidate.expertId);
    const blocker = await readinessBlocker(db, projectId, candidate.expertId);

    recommendations.push({
      expertId: candidate.expertId,
      fullName: candidate.expert.fullName,
      headline: candidate.expert.headline,
      score: candidate.score,
      hourlyRateCents: candidate.expert.hourlyRateCents,
      currency: candidate.expert.currency,
      rationale: eligibility.eligible
        ? blocker
          ? `Match score ${candidate.score}; qualified, but ${blocker.toLowerCase()}`
          : `Match score ${candidate.score}; qualified and ready`
        : `Match score ${candidate.score}; ${eligibility.reason}`,
    });
  }

  return recommendations;
}

/** Convenience for the project screen: gap plus who could close it. */
export async function projectStaffingPicture(db: Db, projectId: string) {
  const [gap, replacements] = await Promise.all([
    computeProjectGap(db, projectId),
    recommendReplacements(db, projectId, 5),
  ]);
  return { gap, replacements };
}

export { daysFromNow };
