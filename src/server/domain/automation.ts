import { type JobType } from '@/server/services/jobs';

/**
 * The automation map.
 *
 * Every event-driven workflow in ExpertOps is declared here, once, as data.
 * The table is the documentation: `docs/automation.md` is generated from the
 * same descriptions, and a test asserts the two agree.
 *
 * Reading the table:
 *
 *  * **trigger** — the business event, named as the activity action that
 *    records it.
 *  * **enqueues** — the job the event schedules. Scheduling happens inside the
 *    same transaction as the business change, so a step and its follow-up
 *    either both happen or neither does.
 *  * **humanApproval** — what a person must decide before anything reaches an
 *    expert or a finance file. `null` means the step is fully automatic.
 *  * **staleCheck** — what the handler re-reads before acting. Jobs are
 *    delivered at least once and may be delayed arbitrarily, so every handler
 *    re-derives current state rather than trusting its payload.
 */
export interface AutomationRule {
  id: string;
  trigger: string;
  description: string;
  enqueues: JobType | null;
  /** Delay before the job becomes runnable, in seconds. */
  delaySeconds?: number;
  humanApproval: string | null;
  staleCheck: string;
  producesOutreach: boolean;
}

export const AUTOMATION_RULES: readonly AutomationRule[] = [
  {
    id: 'application-submitted',
    trigger: 'application.submitted',
    description:
      'A candidate submits an application. The system acknowledges it and creates a screening task.',
    enqueues: 'application.acknowledge',
    humanApproval: null,
    staleCheck: 'Skips if the application was already acknowledged or closed.',
    producesOutreach: true,
  },
  {
    id: 'screening-submitted',
    trigger: 'screening.submitted',
    description:
      'A candidate submits a screening. The system tries to assign a reviewer; if none is available it raises an unassigned-review exception rather than guessing.',
    enqueues: 'screening.assign_reviewer',
    humanApproval: null,
    staleCheck: 'Skips if the screening already has an assigned reviewer or is no longer open.',
    producesOutreach: false,
  },
  {
    id: 'review-overdue',
    trigger: 'schedule:review-reminders',
    description:
      'A reviewer passes their deadline. The system sends one reminder, then escalates to an operator attention item.',
    enqueues: 'review.remind',
    humanApproval: null,
    staleCheck:
      'Re-reads the review state and skips if it was submitted or withdrawn; respects the reminder cap.',
    producesOutreach: true,
  },
  {
    id: 'qualification-approved',
    trigger: 'qualification.granted',
    description:
      'A human approves a screening. The system opens the onboarding checklist for the newly qualified expert.',
    enqueues: 'qualification.apply',
    humanApproval: 'An operator with onboarding:verify decides the qualification.',
    staleCheck: 'Skips if the qualification was revoked or the expert already onboarded.',
    producesOutreach: true,
  },
  {
    id: 'onboarding-verified',
    trigger: 'onboarding.verified',
    description:
      'An operator verifies onboarding. The system rechecks whether the expert can now be staffed on anything they accepted.',
    enqueues: 'readiness.recheck',
    humanApproval: 'An operator verifies the onboarding submission.',
    staleCheck: 'Re-reads the expert status and all accepted invitations at run time.',
    producesOutreach: false,
  },
  {
    id: 'assignment-confirmed',
    trigger: 'assignment.confirmed',
    description:
      'An operator confirms a seat. The system creates project-start tasks and clears the related staffing attention items.',
    enqueues: 'staffing.project_start_tasks',
    humanApproval: 'An operator with staffing:confirm confirms the seat.',
    staleCheck: 'Skips if the assignment was released before the job ran.',
    producesOutreach: false,
  },
  {
    id: 'expert-withdrawal',
    trigger: 'assignment.expert_withdrew',
    description:
      'An expert withdraws. The seat is released, the staffing gap is recomputed, and replacement recommendations are assembled into a batch that a human must approve.',
    enqueues: 'staffing.propose_replacements',
    humanApproval: 'An operator approves the replacement outreach batch before anything is sent.',
    staleCheck: 'Recomputes the gap; skips if the seat was refilled in the meantime.',
    producesOutreach: true,
  },
  {
    id: 'work-submitted',
    trigger: 'work.submitted',
    description: 'An expert submits work. The system creates a review task for an operator.',
    enqueues: 'work.review_task',
    humanApproval: null,
    staleCheck: 'Skips if the work item was already reviewed or cancelled.',
    producesOutreach: false,
  },
  {
    id: 'work-approved',
    trigger: 'work.approved',
    description:
      'An operator approves work. The system drafts a payment item from the authorised quantity. Drafting is idempotent per approved review.',
    enqueues: 'payment.draft_from_approved_work',
    humanApproval: 'An operator approves the work and sets the authorised quantity.',
    staleCheck:
      'Re-reads the work item; returns the existing payment item if one already exists for the review.',
    producesOutreach: false,
  },
  {
    id: 'project-completed',
    trigger: 'project.status_changed:CLOSED',
    description:
      'A project closes. The system opens an offboarding checklist for every staffed expert.',
    enqueues: 'project.offboarding_tasks',
    humanApproval: 'Each checklist item is confirmed manually by a named operator.',
    staleCheck: 'Idempotent per (project, expert, task key).',
    producesOutreach: false,
  },
] as const;

/** Approval gates, stated once so the UI and the docs cannot drift apart. */
export interface ApprovalGate {
  id: string;
  action: string;
  capability: string;
  rule: string;
}

export const APPROVAL_GATES: readonly ApprovalGate[] = [
  {
    id: 'screening-decision',
    action: 'Qualifying or rejecting a screened candidate',
    capability: 'screening:decide',
    rule: 'Needs at least one submitted human review, and any reviewer conflict resolved first.',
  },
  {
    id: 'conflict-resolution',
    action: 'Resolving conflicting reviewer decisions',
    capability: 'screening:resolve_conflict',
    rule: 'The system never breaks a tie. An authorised operator records the outcome and why.',
  },
  {
    id: 'duplicate-resolution',
    action: 'Deciding whether two records are the same person',
    capability: 'candidate:write',
    rule: 'Nothing is ever merged automatically. A confirmed duplicate withdraws the newer record and keeps both on file.',
  },
  {
    id: 'onboarding-verification',
    action: 'Verifying an onboarding submission',
    capability: 'onboarding:verify',
    rule: 'The only route to VERIFIED, which is the only status that can be staffed.',
  },
  {
    id: 'outreach-batch',
    action: 'Dispatching a batch of invitations or replacement outreach',
    capability: 'outreach:approve',
    rule: 'A batch of more than five recipients cannot be approved by the operator who created it.',
  },
  {
    id: 'staffing-confirmation',
    action: 'Confirming a seat',
    capability: 'staffing:confirm',
    rule: 'Consumes capacity under a project row lock. Re-checks verification inside the lock.',
  },
  {
    id: 'work-approval',
    action: 'Approving submitted work',
    capability: 'work:review',
    rule: 'Sets the authorised quantity that payment preparation reads. Judges the submission, not the person.',
  },
  {
    id: 'payment-discrepancy',
    action: 'Clearing a payment discrepancy flag',
    capability: 'payment:write',
    rule: 'Requires a written explanation. A flagged item cannot enter a batch until cleared.',
  },
  {
    id: 'payment-batch',
    action: 'Approving a payment batch',
    capability: 'payment:approve',
    rule: 'Cannot be approved by the operator who created it. Export records a file, never a payment.',
  },
  {
    id: 'offboarding-confirmation',
    action: 'Confirming an offboarding task',
    capability: 'offboarding:confirm',
    rule: 'Records a named operator stating they did something outside this system. Nothing is verified automatically.',
  },
] as const;

/** Reminder policy, applied by every reminder handler. */
export const REMINDER_POLICY = {
  /** Most reminders a single subject may receive for one condition. */
  maxReminders: 2,
  /** Minimum gap between reminders for the same subject, in hours. */
  minIntervalHours: 24,
  /**
   * A reminder is suppressed entirely when the deadline is this close, because
   * chasing someone who has hours left is noise, not help.
   */
  suppressWithinHoursOfDeadline: 2,
  /** Reminders are never sent to a person who opted out of contact. */
  respectsOptOut: true,
} as const;

export function ruleFor(id: string): AutomationRule | undefined {
  return AUTOMATION_RULES.find((rule) => rule.id === id);
}

export function rulesProducingOutreach(): AutomationRule[] {
  return AUTOMATION_RULES.filter((rule) => rule.producesOutreach);
}

export function rulesRequiringApproval(): AutomationRule[] {
  return AUTOMATION_RULES.filter((rule) => rule.humanApproval !== null);
}
