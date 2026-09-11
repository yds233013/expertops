# Automation rules and human-approval boundaries

This document and `src/server/domain/automation.ts` describe the same thing. The
code is the source of truth; a test asserts the two agree.

The dividing line throughout: **routine coordination is automatic, consequential
decisions are not.** Anything that changes someone's standing, spends money, or
reaches an expert in bulk needs a named human.

---

## Event-driven workflows

Each row is a business event, the job it schedules, and what the handler
re-checks before acting. Scheduling happens inside the same transaction as the
business change, so a step and its follow-up either both land or neither does.

| Event | Schedules | Human approval | What the handler re-reads |
| --- | --- | --- | --- |
| `application.submitted` | `application.acknowledge` | none | Skips if already acknowledged or closed; skips if the person opted out |
| `screening.submitted` | `screening.assign_reviewer` | none | Skips if a reviewer is already assigned or the screening moved on |
| Review past its deadline | `review.remind`, then `review.escalate_overdue` | none | Re-reads review state; respects the reminder cap |
| `qualification.granted` | `qualification.apply` | **An operator decides the qualification** | Skips if revoked, or if onboarding already exists |
| `onboarding.verified` | `readiness.recheck` | **An operator verifies onboarding** | Re-reads expert status and every accepted invitation |
| `assignment.confirmed` | `staffing.project_start_tasks` | **An operator confirms the seat** | Skips if the seat was released first |
| `assignment.expert_withdrew` | `staffing.propose_replacements` | **An operator approves the replacement batch** | Recomputes the gap; skips if the seat was refilled |
| `work.submitted` | `work.review_task` | none | Skips if already reviewed or cancelled |
| `work.approved` | `payment.draft_from_approved_work` | **An operator approves the work and sets the quantity** | Returns the existing payment item if one exists |
| Project closed | `project.offboarding_tasks` | **Each checklist item is confirmed by hand** | Idempotent per (project, expert, task) |

### Scheduled sweeps

These run on an interval rather than in response to an event. Every one is
idempotent and safe to run as often as you like.

| Schedule | Every | Does |
| --- | --- | --- |
| `outbox-dispatch` | 15s | Marks queued simulated emails delivered |
| `invitation-expire` | 60s | Closes invitations past their deadline |
| `attention-sweep` | 120s | Recomputes the whole attention queue |
| `invitation-remind` | 300s | One reminder per open invitation |
| `staffing-gap-detection` | 300s | Finds projects that will not be staffed in time |
| `screening-expire` | 300s | Closes screenings whose window passed |
| `screening-remind` | 600s | Reminds candidates, subject to the cap |
| `review-remind` | 600s | Chases reviewers past their deadline |
| `review-escalate` | 600s | Escalates overdue reviews to the queue |
| `onboarding-nudge` | 600s | Nudges stalled onboarding checklists |
| `work-overdue` | 900s | Flags work items past their due date |
| `support-sla` | 600s | Flags unanswered support requests |
| `maintenance-sweep` | 3600s | Purges expired sessions and old finished jobs |

---

## Human approval gates

These ten actions cannot happen without a person. Each is recorded in the
activity history with the operator's identity.

| Action | Capability | The rule |
| --- | --- | --- |
| Qualify or reject a screened candidate | `screening:decide` | Needs at least one submitted human review, and any reviewer conflict resolved first |
| Resolve conflicting reviewer decisions | `screening:resolve_conflict` (admin) | The system never breaks a tie |
| Decide whether two records are the same person | `candidate:write` | Nothing merges automatically; a confirmed duplicate withdraws the newer record and keeps both |
| Verify an onboarding submission | `onboarding:verify` | The only route to VERIFIED, the only status that can be staffed |
| Dispatch a batch of invitations or replacements | `outreach:approve` (admin) | A batch over five recipients cannot be approved by whoever created it |
| Confirm a seat | `staffing:confirm` | Consumes capacity under a row lock; re-checks verification inside the lock |
| Approve submitted work | `work:review` | Sets the authorised quantity payment reads. Judges the submission, never the person |
| Clear a payment discrepancy | `payment:write` | Requires a written explanation; a flagged item cannot enter a batch |
| Approve a payment batch | `payment:approve` (admin) | Cannot be approved by whoever created it |
| Confirm an offboarding task | `offboarding:confirm` | Records a named operator stating they did something outside this system |

### Publishing a rubric

`rubric:publish` is admin-only for a different reason: a published version is
immutable forever, so the act is irreversible rather than merely consequential.

---

## What automation will never do

- **Contact anyone in bulk without approval.** A batch can be assembled
  automatically; dispatching it cannot.
- **Merge two people.** Duplicate detection flags and holds. That is all.
- **Break a reviewer tie.** Disagreement becomes a task, not an average.
- **Revoke or grant a qualification because requirements changed.** Raising a
  project's bar marks affected qualifications `NEEDS_REREVIEW` and stops there.
- **Mark anyone paid.** There is no such action. Export produces a file.
- **Claim an external system was changed.** Offboarding records a human's
  statement, not a verification.
- **Contact someone who opted out.** Enforced in the reminder policy and at
  every send site.

---

## Reminder policy

Declared once, in `REMINDER_POLICY`, and applied by every reminder handler
through `reminderAllowed()`.

| Rule | Value |
| --- | --- |
| Maximum reminders per subject per condition | 2 |
| Minimum interval between reminders | 24 hours |
| Suppressed when the deadline is within | 2 hours |
| Never sent to someone who opted out | always |

Two extra suppressions are applied by specific handlers:

- A screening reminder is not sent in the first 48 hours: the candidate has not
  had a fair run at it yet.
- A reviewer chase ignores the deadline-proximity rule, because the deadline has
  already passed and the point is to chase.

The counter is incremented by the **same conditional update that claims the
subject**, so two workers running at once cannot both send one reminder.

---

## Job safety

Every handler is written for a queue that delivers at least once and may deliver
late.

1. **Re-read current state.** The payload says what happened; the database says
   what is true now.
2. **Be harmless when stale.** A job whose reason has passed returns
   `{ skipped: '...' }` and **succeeds**. It does not fail, because nothing is
   wrong. Failing would raise a false automation alert.
3. **Claim before acting.** Anything that must happen once uses a conditional
   `updateMany` on the expected state, or a unique constraint.

Claiming itself uses `FOR UPDATE SKIP LOCKED`, so multiple workers share one
queue safely, and a job whose worker crashed is reclaimed once its lock goes
stale.

### When automation itself breaks

A job that exhausts its retries becomes `DEAD` and raises an
`AUTOMATION_FAILURE` attention item. Those are listed in their own section of
the Needs-attention screen, never mixed with business blockers: a failing job is
something an engineer fixes, not something an operator can unblock by talking to
an expert.

---

## The attention queue

Rules enforced by `src/server/services/attention.ts` rather than by convention:

- **One row per condition.** `dedupeKey` is derived from the thing that is
  stuck, not from when it was noticed. A sweep every two minutes produces one
  row, not thirty per hour.
- **Self-resolving.** The same sweep that raises items resolves the ones whose
  condition cleared, including items on projects that have left the scanned
  statuses entirely.
- **Every item is actionable.** Blocker, impact and next action are required
  fields on the type, so an item that cannot explain itself cannot be created.
- **An assigned owner survives a refresh.** Re-raising updates the detail and
  the deadline, never the owner an operator chose.
- **Dismissal needs a reason** and is recorded against the operator.
