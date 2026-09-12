import { type Project } from '@prisma/client';
import { type Db, type Transactor } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, notFound } from '@/lib/errors';
import { daysFromNow } from '@/lib/time';
import { type Actor, recordActivity } from './activity';
import { raiseAttention, resolveIfPresent } from './attention';
import { enqueueJob } from './jobs';
import { checkQualificationEligibility } from './qualifications';
import { releaseAssignment } from './staffing';

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
}

/**
 * An expert steps off a project.
 *
 * Releases the seat through the existing staffing service so the capacity
 * accounting and the row lock are reused rather than re-implemented, then
 * immediately recomputes the gap so the shortfall is visible without waiting
 * for the next sweep.
 */
export async function recordWithdrawal(
  client: Transactor,
  actor: Actor,
  input: { projectId: string; expertId: string; reason: string },
): Promise<WithdrawalResult> {
  if (!input.reason.trim()) throw badRequest('A reason is required to record a withdrawal.');

  const expert = await client.expert.findUnique({ where: { id: input.expertId } });
  if (!expert) throw notFound('Expert not found.');

  const project = await client.project.findUnique({ where: { id: input.projectId } });
  if (!project) throw notFound('Project not found.');

  const assignment = await client.assignment.findUnique({
    where: { projectId_expertId: { projectId: input.projectId, expertId: input.expertId } },
  });

  let releasedAssignmentId: string | null = null;
  let seatsFilled = project.seatsFilled;

  if (assignment && (assignment.status === 'PROPOSED' || assignment.status === 'CONFIRMED')) {
    const released = await releaseAssignment(
      client,
      actor,
      assignment.id,
      `Expert withdrew: ${input.reason.trim()}`,
    );
    releasedAssignmentId = released.assignment.id;
    seatsFilled = released.seatsFilled;
  }

  // An accepted invitation is withdrawn too, so the funnel reflects reality.
  await client.invitation.updateMany({
    where: { projectId: input.projectId, expertId: input.expertId, status: 'ACCEPTED' },
    data: {
      status: 'WITHDRAWN',
      withdrawReason: `Expert withdrew: ${input.reason.trim()}`,
      respondedAt: clockNow(),
    },
  });

  await recordActivity(client, {
    actor,
    entityType: 'assignment',
    entityId: assignment?.id ?? input.projectId,
    projectId: input.projectId,
    expertId: input.expertId,
    action: 'assignment.expert_withdrew',
    summary: `${expert.fullName} withdrew from ${project.code}`,
    metadata: { reason: input.reason.trim(), releasedAssignmentId },
  });

  // Anything that was true only because this person held the seat is no longer
  // true, so those items close rather than lingering as noise.
  for (const key of [
    releasedAssignmentId ? `delivery:no_work:${releasedAssignmentId}` : null,
    `staffing:ready:${input.projectId}:${input.expertId}`,
    `staffing:blocked:${input.projectId}:${input.expertId}`,
  ]) {
    if (key) await resolveIfPresent(client, key, 'The expert withdrew from this project.');
  }

  const gap = await computeProjectGap(client, input.projectId);

  await raiseAttention(client, {
    dedupeKey: `staffing:withdrawal:${input.projectId}:${input.expertId}`,
    category: 'staffing.withdrawal',
    severity: 'HIGH',
    title: `${expert.fullName} withdrew from ${project.code}`,
    blocker: `Reason given: ${input.reason.trim()}`,
    impact: `${gap.gap} seat(s) now unfilled on ${project.code}.`,
    nextAction: 'Review replacement recommendations and send an approved outreach batch.',
    projectId: input.projectId,
    expertId: input.expertId,
    dueAt: project.startDate,
    metadata: { reason: input.reason.trim(), gap: gap.gap },
  });

  // Replacement recommendations are assembled by a job; they are never sent.
  // Dispatch waits on an operator approving the resulting batch.
  await enqueueJob(client, {
    type: 'staffing.propose_replacements',
    payload: { projectId: input.projectId },
    priority: 20,
    dedupeKey: `staffing.propose_replacements:${input.projectId}:${clockNow().getTime()}`,
    // Timestamped, so unique per call. See invitation.send.
    dedupeScope: 'DISPOSABLE',
  });

  return { releasedAssignmentId, seatsFilled, gap };
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

  const excluded = await db.invitation.findMany({
    where: { projectId, status: { in: ['DRAFT', 'SENT', 'ACCEPTED'] } },
    select: { expertId: true },
  });
  const assigned = await db.assignment.findMany({
    where: { projectId, status: { in: ['PROPOSED', 'CONFIRMED', 'COMPLETED'] } },
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
