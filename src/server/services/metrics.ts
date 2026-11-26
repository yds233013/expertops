import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { taskCheckCounts } from './task-quality';

/**
 * Network metrics: the numbers an operator is accountable for.
 *
 * Every figure is computed from rows already in the database, over a window,
 * and returned with the counts behind it so a rate is never shown without its
 * denominator. Nothing is cached or stored: the page is the query.
 *
 * Definitions are written next to each figure and repeated on the page. A
 * metric whose definition is not visible is a metric people argue about.
 */

export const METRIC_WINDOWS = [30, 90, 365] as const;
export type MetricWindow = (typeof METRIC_WINDOWS)[number];

const DAY_MS = 86_400_000;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function share(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

const SCREENED_STAGES = new Set([
  'SCREENING_INVITED',
  'SCREENING_SUBMITTED',
  'IN_REVIEW',
  'REVISION_REQUESTED',
  'QUALIFIED',
  'REJECTED',
]);

export interface FunnelRow {
  key: string;
  label: string;
  candidates: number;
  /** Reached screening: invited to it, or past it. */
  screened: number;
  qualified: number;
  rejected: number;
  qualifiedRate: number | null;
}

export interface NetworkMetrics {
  windowDays: MetricWindow;
  since: Date;
  generatedAt: Date;
  funnel: {
    total: FunnelRow;
    byChannel: FunnelRow[];
    byDomain: FunnelRow[];
  };
  speed: {
    /** Candidate created → first qualification decided, in days. */
    medianDaysToQualify: number | null;
    qualifiedSample: number;
    /** Work submitted → first decided review, in hours. */
    medianReviewHours: number | null;
    reviewSample: number;
    /** Work approved → its payment batch exported, in days. */
    medianDaysApprovalToExport: number | null;
    payoutSample: number;
  };
  staffing: {
    openProjects: number;
    seatsRequested: number;
    seatsFilled: number;
    fillRate: number | null;
    /** Confirmed seats in the window later released before completion. */
    confirmed: number;
    released: number;
    dropoutRate: number | null;
  };
  delivery: {
    approved: number;
    approvedFirstTime: number;
    firstTimeApprovalRate: number | null;
    /**
     * Batched or exported payment value for work approved in the window, in
     * the currency most of it was paid in. Cost per approved item divides by
     * the paid items, not all approved items: approved work not yet in a
     * batch has no settled cost.
     */
    paidMinor: number;
    paidItems: number;
    costPerApprovedMinor: number | null;
    currency: string;
    /** Paid items in other currencies, left out of the figures above. */
    otherCurrencyItems: number;
  };
  taskQuality: Awaited<ReturnType<typeof taskCheckCounts>> & {
    flaggedRate: number | null;
  };
}

function funnelRow(
  key: string,
  label: string,
  candidates: { stage: string; hasScreening: boolean }[],
): FunnelRow {
  // REJECTED counts as screened only when a screening exists: a candidate can
  // be turned down at application without ever being screened.
  const screened = candidates.filter(
    (candidate) =>
      candidate.hasScreening ||
      (candidate.stage !== 'REJECTED' && SCREENED_STAGES.has(candidate.stage)),
  ).length;
  const qualified = candidates.filter((candidate) => candidate.stage === 'QUALIFIED').length;
  const rejected = candidates.filter((candidate) => candidate.stage === 'REJECTED').length;
  return {
    key,
    label,
    candidates: candidates.length,
    screened,
    qualified,
    rejected,
    qualifiedRate: share(qualified, candidates.length),
  };
}

export async function networkMetrics(
  db: Db,
  options: { windowDays?: MetricWindow; now?: Date } = {},
): Promise<NetworkMetrics> {
  const windowDays = options.windowDays ?? 90;
  const generatedAt = options.now ?? clockNow();
  const since = new Date(generatedAt.getTime() - windowDays * DAY_MS);

  const [candidates, qualifications, workItems, projects, assignments, checks] = await Promise.all([
    db.candidate.findMany({
      where: { createdAt: { gte: since } },
      select: {
        id: true,
        stage: true,
        createdAt: true,
        expertId: true,
        sourceChannel: { select: { id: true, name: true } },
        applications: {
          select: { domain: { select: { id: true, name: true } } },
          orderBy: { submittedAt: 'asc' },
          take: 1,
        },
        _count: { select: { screenings: true } },
      },
    }),
    db.qualification.findMany({
      where: { decidedAt: { gte: since } },
      select: { expertId: true, decidedAt: true },
      orderBy: { decidedAt: 'asc' },
    }),
    db.workItem.findMany({
      where: { status: { not: 'CANCELLED' }, updatedAt: { gte: since } },
      select: {
        status: true,
        approvedAt: true,
        submissions: { select: { revision: true, submittedAt: true } },
        reviews: { select: { state: true, decidedAt: true, submissionId: true } },
        paymentItem: {
          select: {
            amountMinor: true,
            currency: true,
            status: true,
            supersededById: true,
            batch: { select: { exportedAt: true } },
          },
        },
      },
    }),
    db.project.findMany({
      where: { status: { in: ['MATCHING', 'INVITING', 'STAFFING', 'ACTIVE'] } },
      select: { seatsRequested: true, seatsFilled: true },
    }),
    db.assignment.findMany({
      where: { confirmedAt: { gte: since } },
      select: { status: true, releasedAt: true },
    }),
    taskCheckCounts(db, { since }),
  ]);

  // --- Funnel -------------------------------------------------------------
  const shaped = candidates.map((candidate) => ({
    stage: candidate.stage as string,
    hasScreening: candidate._count.screenings > 0,
    channel: candidate.sourceChannel,
    domain: candidate.applications[0]?.domain ?? null,
  }));

  function groupBy(pick: (row: (typeof shaped)[number]) => { id: string; name: string } | null) {
    const groups = new Map<string, { label: string; rows: typeof shaped }>();
    for (const row of shaped) {
      const target = pick(row);
      const key = target?.id ?? 'none';
      const label = target?.name ?? 'Not recorded';
      const group = groups.get(key) ?? { label, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
    return [...groups.entries()]
      .map(([key, group]) => funnelRow(key, group.label, group.rows))
      .sort((a, b) => b.candidates - a.candidates);
  }

  // --- Speed --------------------------------------------------------------
  const firstQualification = new Map<string, Date>();
  for (const qualification of qualifications) {
    if (!firstQualification.has(qualification.expertId)) {
      firstQualification.set(qualification.expertId, qualification.decidedAt);
    }
  }
  const daysToQualify = candidates.flatMap((candidate) => {
    const decided = candidate.expertId ? firstQualification.get(candidate.expertId) : undefined;
    if (!decided || decided < candidate.createdAt) return [];
    return [(decided.getTime() - candidate.createdAt.getTime()) / DAY_MS];
  });

  const reviewHours: number[] = [];
  const approvalToExportDays: number[] = [];
  let approved = 0;
  let approvedFirstTime = 0;
  // Amounts in different currencies are never added together.
  const paidByCurrency = new Map<string, { minor: number; items: number }>();

  for (const item of workItems) {
    for (const submission of item.submissions) {
      const firstDecision = item.reviews
        .filter((review) => review.state !== 'PENDING' && review.decidedAt)
        .map((review) => review.decidedAt as Date)
        .filter((decidedAt) => decidedAt >= submission.submittedAt)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      if (firstDecision && submission.submittedAt >= since) {
        reviewHours.push((firstDecision.getTime() - submission.submittedAt.getTime()) / 3_600_000);
      }
    }

    if (item.status === 'APPROVED' && item.approvedAt && item.approvedAt >= since) {
      approved += 1;
      if (!item.reviews.some((review) => review.state === 'REVISION_REQUESTED')) {
        approvedFirstTime += 1;
      }
      const payment = item.paymentItem;
      if (payment && payment.status !== 'VOID' && payment.supersededById === null) {
        if (payment.status === 'IN_BATCH' || payment.status === 'EXPORTED') {
          const bucket = paidByCurrency.get(payment.currency) ?? { minor: 0, items: 0 };
          bucket.minor += payment.amountMinor;
          bucket.items += 1;
          paidByCurrency.set(payment.currency, bucket);
        }
        const exportedAt = payment.batch?.exportedAt;
        if (exportedAt && exportedAt >= item.approvedAt) {
          approvalToExportDays.push((exportedAt.getTime() - item.approvedAt.getTime()) / DAY_MS);
        }
      }
    }
  }

  // Report the currency most approved work was paid in; count the rest.
  const [currency, paid] = [...paidByCurrency.entries()].sort(
    (a, b) => b[1].items - a[1].items,
  )[0] ?? ['USD', { minor: 0, items: 0 }];
  const paidMinor = paid.minor;
  const paidItems = paid.items;
  const otherCurrencyItems =
    [...paidByCurrency.values()].reduce((sum, bucket) => sum + bucket.items, 0) - paidItems;

  // --- Staffing -----------------------------------------------------------
  const seatsRequested = projects.reduce((sum, project) => sum + project.seatsRequested, 0);
  const seatsFilled = projects.reduce((sum, project) => sum + project.seatsFilled, 0);
  const released = assignments.filter((assignment) => assignment.status === 'RELEASED').length;

  const completedChecks = checks.total - checks.INCONCLUSIVE;
  const flagged = checks.BROKEN_SPEC + checks.ANSWER_LEAK + checks.TOO_EASY;

  return {
    windowDays,
    since,
    generatedAt,
    funnel: {
      total: funnelRow('all', 'All candidates', shaped),
      byChannel: groupBy((row) => row.channel),
      byDomain: groupBy((row) => row.domain),
    },
    speed: {
      medianDaysToQualify: median(daysToQualify),
      qualifiedSample: daysToQualify.length,
      medianReviewHours: median(reviewHours),
      reviewSample: reviewHours.length,
      medianDaysApprovalToExport: median(approvalToExportDays),
      payoutSample: approvalToExportDays.length,
    },
    staffing: {
      openProjects: projects.length,
      seatsRequested,
      seatsFilled,
      fillRate: share(seatsFilled, seatsRequested),
      confirmed: assignments.length,
      released,
      dropoutRate: share(released, assignments.length),
    },
    delivery: {
      approved,
      approvedFirstTime,
      firstTimeApprovalRate: share(approvedFirstTime, approved),
      paidMinor,
      paidItems,
      costPerApprovedMinor: paidItems === 0 ? null : Math.round(paidMinor / paidItems),
      currency,
      otherCurrencyItems,
    },
    taskQuality: { ...checks, flaggedRate: share(flagged, completedChecks) },
  };
}
