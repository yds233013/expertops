# Requirement coverage

What was asked for, where it lives, and what proves it. Anything unfinished is
in the last section rather than hidden in the table.

Legend: **Done** — implemented and covered by a test. **Partial** — implemented
but narrower than the requirement suggests. **Not done** — stated explicitly.

---

## Milestone 1 — verify and complete the foundation

| Requirement | Status | Where | Proof |
| --- | --- | --- | --- |
| Map original requirements to behaviour and tests | Done | This document | — |
| Investigate the two no-op job types | Done | Both removed | `worker.test.ts` asserts they cannot return |
| Implement required jobs they should have been | Done | `staffing.detect_gaps` added; reminders/expiry already existed | `worker.test.ts`, `withdrawal-and-attention.test.ts` |
| Unsupported jobs must not masquerade as successful | Done | No handler returns a fake success | `worker.test.ts` greps the handler source |
| Operator confirmation before invitation dispatch | Done | Single invites are an operator click; batches need approval | `withdrawal-and-attention.test.ts` |
| Operator confirmation before staffing assignment | Done | `confirmAssignment` under a row lock | `failure-cases.test.ts`, `concurrency.test.ts` |
| CSRF protection, both session kinds | Done | `src/server/http/csrf.ts`, applied in the request guards | `csrf.test.ts` (18 tests) |
| Test cross-origin mutation rejection | Done | Foreign origin, absent origin, missing header, mismatched header, forged cookie | `csrf.test.ts` |
| Server-side roles | Done | 49 capabilities, three roles | `permissions.test.ts`, `extension-access.test.ts` |
| Token scoping and expiry | Done | Single-use magic links, separate expert and candidate tables | `failure-cases.test.ts`, `portal.test.ts` |
| Opt-out handling | Done | `Candidate.contactOptOutAt`, honoured at every send site | `screening.test.ts`, `decimal-and-csv.test.ts` |
| Concurrency protection | Done | Row locks, conditional updates, unique constraints | `concurrency.test.ts` (16 tests) |
| Atomic activity logging | Done | History written inside the caller's transaction | `activity-and-outbox.test.ts` |

### On the two no-op jobs

`assignment.notify` and `onboarding.notify_decision` reported `SUCCEEDED` while
doing nothing, and nothing enqueued them. Neither corresponded to a required
behaviour: invitation reminders, invitation expiry and onboarding reminders were
already implemented and tested. The genuinely missing job was **staffing-gap
detection**, which did not exist at all.

Both were deleted rather than left looking healthy on the Worker screen, and the
work they gestured at (notifying an external system) is listed under *Not done*
below.

---

## Milestone 2 — applications and domain screening

| Requirement | Status | Where |
| --- | --- | --- |
| Sourcing campaigns tied to project shortages | Done | `sourcing.ts`, `SourcingCampaign.projectId` |
| Community/referral sources | Done | `SourceChannel`, with an effectiveness view |
| Relationship owner, notes, next-action date | Done | `Candidate`, `updateRelationship` |
| Structured applications and a candidate pipeline | Done | `Application`, `CandidateStage` |
| Duplicate detection with human resolution, never silent merge | Done | `detectDuplicates`, `resolveDuplicate` |
| Screening templates by domain | Done | `ScreeningTemplate` |
| Versioned criteria, scoring guidance, required evidence | Done | `RubricCriterion` |
| Human decision rules | Done | `grantQualification` requires a submitted review |
| Screening invitations, submissions, reviewer assignment | Done | `screening.ts` |
| Review deadlines, revision requests, reviewer decisions | Done | `screening.ts` |
| Qualification records linked to evidence/version/reviewer/domain/date | Done | `Qualification` |
| Synthetic work samples, never executed or fetched | Done | `validateWorkSampleLink` stores text only |
| Screening distinct from project invitation | Done | Separate services, separate tables, no shared path |
| Existing project eligibility checks preserved | Done | `proposeAssignment` unchanged; qualification is an additional gate |
| Published rubrics immutable; edits create a version | Done | `updateDraftVersion` refuses |
| Existing screenings retain their version | Done | Tested explicitly |
| Changing requirements surfaces re-review | Done | `setProjectQualificationRequirement` |
| Conflicting reviews create a resolution task | Done | `ReviewConflict`, admin-only |
| Experts cannot view private reviewer notes | Done | `getScreeningForCandidate` selects fields explicitly |

Covered by `screening.test.ts` (32 tests).

---

## Milestone 3 — connected automation and exception queue

| Requirement | Status | Where |
| --- | --- | --- |
| All ten event-driven workflows | Done | `automation.ts`, `handlers.ts`, `docs/automation.md` |
| Invitation and replacement batches need approval | Done | `outreach.ts` |
| Qualification/verification/assignment/work/payment need human decisions | Done | Ten approval gates |
| Shared business services for UI and worker | Done | Handlers call the same services as routes |
| Atomic business change + audit + job scheduling | Done | `enqueueJob` inside the caller's transaction |
| Safe under duplicate delivery, retries, crashes, multiple workers | Done | `concurrency.test.ts`, `withdrawal-and-attention.test.ts` |
| Recheck state before acting | Done | Every handler re-reads |
| Stale jobs harmless | Done | Return `{ skipped }` and succeed |
| Reminder limits and suppression | Done | `REMINDER_POLICY`, `reminderAllowed` |
| "Needs attention" as the main surface | Done | `/attention` |
| Concrete blocker and impact | Done | Required fields on the type |
| Owner or explicit unassigned | Done | Shown, assignable |
| Due date and next action | Done | Required |
| Links to records | Done | Project, expert, candidate |
| Automatic resolution | Done | Sweeps resolve, including orphaned items |
| No duplicate alerts | Done | Unique `dedupeKey` |
| Automation failures shown separately | Done | Separate section, separate count |

---

## Milestone 4 — delivery, support and payment preparation

| Requirement | Status | Where |
| --- | --- | --- |
| Work items with expert, instructions, due date, submission, revisions | Done | `WorkItem`, `WorkSubmission` |
| Human review states | Done | `PENDING` / `REVISION_REQUESTED` / `APPROVED` |
| Structured reviewer feedback | Done | Four named dimensions, validated |
| No automatic expert-wide ranking from one review | Done | Nothing writes to the expert; asserted by a test |
| Support requests linked to their project | Done | `SupportRequest` |
| Category, message, owner, status, replies, response deadline | Done | With per-category targets |
| A support issue can block readiness or delivery | Done | Read by `readinessBlocker` |
| Experts see only their own requests and permitted replies | Done | `listSupportForExpert` |
| Agreed rate, currency, authorised basis, approved quantity | Done | `PaymentItem` |
| Precise decimal/integer arithmetic | Done | `src/lib/decimal.ts` |
| Idempotent draft creation | Done | Unique on `workReviewId` |
| Discrepancy flags, human approval, CSV export | Done | `payments.ts` |
| Same work cannot be in two active batches | Done | Checked against active batch statuses |
| Corrections preserve history and invalidate approvals | Done | Supersede, not edit |
| Exported is not paid | Done | No `PAID` status exists anywhere |
| Offboarding tasks with owners and manual confirmations | Done | `offboarding.ts` |
| No claim that external accounts were removed | Done | Stated in the task text, the API response and the activity metadata |

Covered by `delivery-and-payment.test.ts` (25 tests).

---

## Milestone 5 — demonstrate and verify

| Requirement | Status | Where |
| --- | --- | --- |
| Repeatable isolated cybersecurity demo | Done | `scripts/demo.ts`, run-tagged and additive |
| Project requires four experts | Done | Step 2 |
| Some qualify, shortage creates sourcing work | Done | Step 3 |
| Candidate submits incomplete screening | Done | Step 4 |
| Reviewer becomes overdue | Done | Step 5 |
| Qualified expert lacks capacity | Done | Step 3 (0 h/week) |
| Accepted expert has an onboarding blocker | Done | Step 6 (blocking support request) |
| Assigned expert withdraws | Done | Step 7 |
| Replacement approved | Done | Step 8 |
| Work needs revision, then approval | Done | Step 9 |
| Payment discrepancy resolved before export | Done | Step 10 |
| Clock abstraction in tests and demo | Done | `src/lib/clock.ts` |
| No arbitrary-time-change HTTP endpoint | Done | In-process only; refuses in production |
| CSV import with preview and validation | Done | `expert-import.ts` |
| Report errors and duplicates | Done | Per-row verdicts |
| Qualifications not imported as verified decisions | Done | Recorded as a note; asserted by a test |
| Formula-injection protection on export | Done | `escapeCell` |
| Isolated test database with safeguards | Done | `src/lib/database-safety.ts` fail-closed allow list, `src/lib/suite-lock.ts` cross-process lock, three separate databases |
| Browser verification of both journeys | Done | `tests/e2e/` — 25 Playwright tests against a production build, real PostgreSQL and a real worker |

### Required tests

All present and passing:

| Test | File |
| --- | --- |
| Duplicate events and requests | `withdrawal-and-attention.test.ts` |
| Worker restart/retry and concurrent claiming | `worker.test.ts`, `concurrency.test.ts` |
| Stale reminder suppression | `lifecycle.test.ts` |
| Cross-expert and unauthorised access | `delivery-and-payment.test.ts`, `extension-access.test.ts` |
| Rubric version preservation and conflicting reviews | `screening.test.ts` |
| Qualifications not automatically granting assignment | `screening.test.ts` |
| Last-seat and overlapping-capacity races | `concurrency.test.ts` |
| Withdrawal and replacement flow | `withdrawal-and-attention.test.ts` |
| Duplicate payment preparation and batch inclusion | `delivery-and-payment.test.ts` |
| Full application → payment export workflow | `lifecycle.test.ts` |

---

## Milestone 6 — completing the scope

Added in this pass. Everything below is reachable in a browser; none of it
requires an API call.

| Requirement | Status | Where | Proof |
| --- | --- | --- | --- |
| Candidate opens a simulated screening invitation | Done | `/apply/enter/[token]` | `journey.spec.ts` step 4 |
| Candidate reads instructions and the criteria | Done | `/apply` | `journey.spec.ts` step 4 |
| Candidate enters and submits responses | Done | `components/apply/screening-form.tsx` | `journey.spec.ts` step 4 |
| Candidate sees submission status and what is missing | Done | `/apply` renders the latest submission's missing evidence | `journey.spec.ts` step 4 |
| Candidate reads permitted revision feedback | Done | `Screening.revisionFeedback` plus public reviewer feedback | `journey.spec.ts` step 6 |
| Candidate edits and resubmits | Done | The form is pre-filled from their own last submission | `journey.spec.ts` step 6 |
| Candidate sees the next step | Done | `CANDIDATE_NEXT_STEP` per status | `candidate-portal.test.ts` |
| Private reviewer notes never reach a candidate | Done | `getScreeningForCandidate` selects fields explicitly | `candidate-portal.test.ts`, `journey.spec.ts` step 6 |
| Invalid / expired / revoked / consumed links handled clearly | Done | `redeemCandidateToken` messages, rendered by the entry page | `candidate-portal.test.ts`, `access.spec.ts` |
| Changing an id cannot expose another candidate | Done | Authorisation is by session, never by URL | `candidate-portal.test.ts`, `access.spec.ts` |
| Token-bearing URLs kept out of logs | Done | Token travels in a POST body; the entry page replaces the URL; screenshots refuse `/enter/` | `screenshots.spec.ts` asserts it |
| Rubric authoring: draft, edit, validate, publish, new version | Done | `/rubrics` | `journey.spec.ts` step 1 |
| Published versions immutable in the UI | Done | The editor is replaced by a read-only view | `journey.spec.ts` step 1 |
| Existing screenings keep their recorded version | Done | Unchanged service rule | `screening.test.ts` |
| Campaign detail: shortage, sources, referrals, candidates, owner, next actions, progress | Done | `/campaigns/[campaignId]` | `journey.spec.ts` step 2, `responsive.spec.ts` |
| Screening review and qualification decisions in the browser | Done | `/screenings` | `journey.spec.ts` steps 5 and 7 |
| Revision requests and conflict resolution in the browser | Done | `/screenings` decision panel | `journey.spec.ts` step 5 |
| Operator replies to support | Done | `/support` | `journey.spec.ts` step 12 |
| Expert replies to support | Done | Portal support panel | `journey.spec.ts` step 12 |
| Conversation history, ownership, status, linked blocker | Done | `/support` | `journey.spec.ts` step 12 |
| Participant scope and roles enforced server-side | Done | `replyToSupport`, `listSupportForExpert` | `support-conversations.test.ts` |
| Private operator notes never appear as expert-visible replies | Done | Filtered in the service, marked in the operator UI | `support-conversations.test.ts`, `journey.spec.ts` step 12 |
| Expert submits work in the browser | Done | Portal work panel | `journey.spec.ts` step 13 |
| Operator assigns work in the browser | Done | `/work` | `journey.spec.ts` step 13 |
| Operator creates and exports a payment batch in the browser | Done | `/payments` | `journey.spec.ts` step 14 |
| Approved work appears once in payment preparation | Done | Idempotent draft creation | `journey.spec.ts` step 14, `delivery-and-payment.test.ts` |
| Test databases cannot be confused with development | Done | `database-safety.ts`, `suite-lock.ts` | `database-safety.test.ts` (18 tests) |
| Responsive usability at desktop and narrow mobile | Done | Checked mechanically at 1280px and 375px | `responsive.spec.ts` |

### The browser suite

`npm run e2e` starts a production build on port 3100 against `expertops_e2e`
and a real worker process, then runs 25 tests in four files:

| File | What it proves |
| --- | --- |
| `journey.spec.ts` | One continuous journey in 14 steps, from authoring a rubric to exporting an approved payment batch. Operator, candidate and expert each have their own browser context. |
| `access.spec.ts` | Expired, revoked and already-used links are refused with a readable reason; one candidate cannot reach another's screening by changing an id; operator pages redirect to sign-in. |
| `responsive.spec.ts` | Every principal operator page plus the candidate portal at 1280px and 375px: no sideways scrolling, every control has an accessible name, focus is visible, and the candidate form can be completed and submitted by keyboard. |
| `screenshots.spec.ts` | Writes the walkthrough images in `docs/screenshots/`, refusing to photograph any page whose URL contains a token. |

Fixture setup (operator accounts, one domain, two skills, one pre-published
rubric) is done with helpers. Every action the suite verifies happens in the
browser.

---

## Independent review repairs

An independent review of `1d34bbc` raised six findings. Each was reproduced
before it was repaired, and each repair carries a regression test.
[`docs/review-repairs.md`](review-repairs.md) has the reproduction output, the
change, and what the tests actually demonstrate.

| Finding | Status | Where | Proof |
| --- | --- | --- | --- |
| Access tokens in initial request URLs | Fixed | Token moved to the URL fragment; `/apply/enter`, `/portal/enter`; `Referrer-Policy` | `token-exposure.test.ts`, browser log verification |
| A running job reclaimed while its worker was alive | Fixed | `claimId` fencing token, bounded lease with renewal | `worker-ownership.test.ts` |
| `completeJob` / `failJob` keyed by job id alone | Fixed | Both scoped to the claim; completion inside the handler's transaction | `worker-ownership.test.ts` |
| Stale execution creating duplicate business effects | Fixed | Losing the claim rolls the handler's writes back | `worker-ownership.test.ts` |
| Unbounded stale-job recovery | Fixed | `attempts < maxAttempts` in the claim, plus `reapAbandonedJobs` | `worker-ownership.test.ts` |
| State, audit and follow-up work not atomic | Fixed | `withTransaction`, transaction-aware outreach services | `outreach-atomicity.test.ts` |
| Infrastructure faults recorded as permanent exclusions | Fixed | `SKIPPED` vs `FAILED`, `PARTIALLY_DISPATCHED` | `outreach-atomicity.test.ts` |
| A schedule tick consumed by a failed enqueue | Fixed | Claim and enqueue in one transaction | `scheduler-atomicity.test.ts` |
| Bulk outreach had no UI | Fixed | `/outreach`, `/outreach/[batchId]` | `outreach.spec.ts` (6 browser steps) |
| Offboarding tasks with no accountable owner | Fixed | Unassigned queue, `offboarding:assign`, owner control | `withdrawal-and-attention.test.ts` |
| "Ran" indistinguishable from "did something" | Fixed | `src/lib/job-outcome.ts`, *What it did* column | `job-outcome.test.ts` |
| Job history growth undocumented | Fixed | Retention policy in `docs/architecture.md` | `worker-ownership.test.ts` |

---

## Second review round

Four further findings against `4872981`, each reproduced before repair.
[`docs/review-repairs.md`](review-repairs.md) has the detail.

| Finding | Status | Where | Proof |
| --- | --- | --- | --- |
| Pruning freed business-event deduplication keys | Fixed | `Job.dedupeScope`, explicit and defaulting to DURABLE | `dedupe-retention.test.ts` |
| Replaying a pruned event repeated its effects | Fixed | Key retained, so the replay deduplicates | `dedupe-retention.test.ts` replays a real `onboarding.start` after a real sweep |
| Dispatch counted work another request committed | Fixed | Per-recipient outcome; `takenByAnotherRequest` | `outreach-concurrency.test.ts` |
| A stale failure could overwrite a sent recipient | Fixed | `recordDispatchFailure` compare-and-set | `outreach-concurrency.test.ts` |
| Batch status came from the caller's tally | Fixed | `recipientTotals` read back from the rows | `outreach-concurrency.test.ts` |
| `npm run build` overwrote the dev server's output | Fixed | `.next-dev`, `.next-prod`, `.next-e2e` | Build run against a live dev server; production start serves its own build id |
| Worker guarantee stated too broadly | Corrected | Database-only, stated in three documents | No code change; no regression demonstrated one |
| Batch finalisation raced a concurrent finish | Fixed | `finaliseBatch` locks the batch row, then reads totals inside that transaction | `outreach-concurrency.test.ts`; both new tests fail against the pre-fix code with `DISPATCHED → PARTIALLY_DISPATCHED` |

---

## Not done

Stated plainly rather than left to be discovered.

**External-system notification.** The removed no-op jobs gestured at pushing a
confirmed assignment or a verification decision to a client-side system. No such
integration exists, and no job pretends to be one. Adding it means an adapter,
credentials and a retry/bounce story that this build deliberately has none of.

**No real email, payments, or external accounts.** Every message is written to
the in-app outbox. Payment preparation produces a CSV and nothing else; there is
no `PAID` status anywhere in the schema, on purpose.

**Accessibility is checked mechanically, not audited.** The browser suite
asserts four specific things at two viewport widths: the document does not
scroll sideways, every interactive control has an accessible name, keyboard
focus is visible, and the candidate form can be completed and submitted with the
keyboard alone. That is not an audit. Nothing has been tested with a screen
reader, colour contrast has not been measured, and no assistive technology
beyond the keyboard has been used.

**Offboarding is read-mostly in the UI.** Tasks are listed on the Delivery
screen and can be confirmed there, but there is no screen for creating or
reassigning one; that remains an API operation.

**Campaign candidates are assigned, not recruited, through the UI.** A candidate
is attached to a campaign when they are added. There is no screen for moving an
existing candidate between campaigns.

**Bulk outreach has no dedicated screen.** Outreach batches exist as a service
with an approval gate and are visible in the attention queue and activity
history, but composing one is an API call.

**Single browser engine.** The suite runs in Chromium only. Firefox and WebKit
are not exercised.
