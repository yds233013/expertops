import { type Db } from '@/lib/db';
import { attentionCounts } from './attention';
import { candidateCountsByStage } from './candidates';
import { jobCounts } from './jobs';
import { onboardingCounts } from './onboarding';
import { outboxCounts } from './outbox';
import { paymentCounts } from './payments';
import { supportCounts } from './support';
import { workCounts } from './work';

/**
 * Everything waiting on a person, in one place.
 *
 * The sidebar badges and the dashboard's work queue used to count these
 * separately, which is how two numbers for the same thing end up disagreeing on
 * one screen. Both now read this.
 */
export interface Queue {
  /** The page that works through it, which is also the key for its nav badge. */
  href: string;
  label: string;
  /** What a person does with an item in this queue. */
  action: string;
  count: number;
}

export async function workloadQueues(db: Db): Promise<{ queues: Queue[]; highSeverity: number }> {
  const [attention, candidates, onboarding, work, support, payments, outbox, jobs, outreach, apps] =
    await Promise.all([
      attentionCounts(db),
      candidateCountsByStage(db),
      onboardingCounts(db),
      workCounts(db),
      supportCounts(db),
      paymentCounts(db),
      outboxCounts(db),
      jobCounts(db),
      db.outreachBatch.count({ where: { status: 'PENDING_APPROVAL' } }),
      db.application.count({ where: { status: 'SUBMITTED', withdrawnAt: null } }),
    ]);

  return {
    highSeverity: attention.high,
    queues: [
      {
        href: '/attention',
        label: 'Needs attention',
        action: 'Unblock stuck work',
        count: attention.total,
      },
      {
        href: '/opportunities',
        label: 'New applications',
        action: 'Read and decide on the next step',
        count: apps,
      },
      {
        href: '/candidates',
        label: 'Candidates to review',
        action: 'Resolve duplicates and review screenings',
        count: candidates.DUPLICATE_HOLD + candidates.SCREENING_SUBMITTED + candidates.IN_REVIEW,
      },
      {
        href: '/outreach',
        label: 'Outreach to approve',
        action: 'A second operator approves before anything is queued',
        count: outreach,
      },
      {
        href: '/onboarding',
        label: 'Onboarding to verify',
        action: 'Check submitted checklists',
        count: onboarding.SUBMITTED,
      },
      {
        href: '/work',
        label: 'Work to review',
        action: 'Approve or return submissions',
        count: work.SUBMITTED + work.IN_REVIEW,
      },
      {
        href: '/support',
        label: 'Support requests',
        action: 'Reply to experts',
        count: support.OPEN + support.WAITING_ON_OPS,
      },
      {
        href: '/payments',
        label: 'Payment discrepancies',
        action: 'Explain or correct before batching',
        count: payments.withOpenDiscrepancies,
      },
      {
        href: '/outbox',
        label: 'Simulated emails queued',
        action: 'Written to the outbox, never sent',
        count: outbox.QUEUED,
      },
      {
        href: '/jobs',
        label: 'Failed background jobs',
        action: 'Engineering: inspect and retry',
        count: jobs.DEAD + jobs.FAILED,
      },
    ],
  };
}
