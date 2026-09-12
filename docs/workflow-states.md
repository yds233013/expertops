# Workflow states

Every status transition in ExpertOps is declared once, in
`src/server/domain/state-machines.ts`, and enforced by `assertTransition`.
Services call it before writing; route handlers and the worker never re-check a
transition themselves. `tests/unit/state-machines.test.ts` asserts each table.

Three things `assertTransition` does that are worth knowing:

- An illegal transition throws `INVALID_STATE` **listing what is allowed**, and
  that list reaches the API caller in `error.details.allowed`.
- A terminal state says so explicitly rather than listing an empty set.
- A no-op (`X → X`) is rejected rather than silently succeeding, so a
  double-submitted form is an error rather than a quiet nothing.

---

## The happy path

```
  OPERATOR                EXPERT                  OPERATOR              SYSTEM
     │                      │                        │                    │
  create project            │                        │                    │
     │ DRAFT                │                        │                    │
  open for matching         │                        │                    │
     │ MATCHING             │                        │                    │
  run matching ─────────────┼────────────────────────┼────────────────────┤ scores candidates
     │                      │                        │                    │
  invite ───────────────────┼────────────────────────┼────────────────────┤ renders + "sends"
     │ INVITING             │                        │                    │   (simulated)
     │                   accept                      │                    │
     │                      │ ONBOARDING             │                    │
     │ STAFFING          declare availability        │                    │
     │                   complete checklist          │                    │
     │                   submit                      │                    │
     │                      │ PENDING_VERIFICATION   │                    │
     │                      │                     verify  ◀── human decision
     │                      │ VERIFIED               │                    │
     │                      │                     propose seat            │
     │                      │                     confirm seat ◀── consumes a seat
     │ ACTIVE               │                        │                    │ queues confirmation
```

---

## Project

`ProjectStatus`

| From | To | Meaning |
| --- | --- | --- |
| `DRAFT` | `MATCHING`, `CANCELLED` | Being written |
| `MATCHING` | `DRAFT`, `INVITING`, `CANCELLED` | Requirements frozen enough to score |
| `INVITING` | `MATCHING`, `STAFFING`, `CANCELLED` | Invitations are out |
| `STAFFING` | `INVITING`, `ACTIVE`, `CLOSED`, `CANCELLED` | At least one acceptance |
| `ACTIVE` | `STAFFING`, `CLOSED`, `CANCELLED` | All seats filled |
| `CLOSED` | — | Terminal |
| `CANCELLED` | — | Terminal |

**Guards**

- Moving to `MATCHING` requires at least one skill requirement. Without one,
  every expert in the network scores identically.
- Moving to `ACTIVE` requires `seatsFilled >= seatsRequested`.
- A `CLOSED` or `CANCELLED` project cannot be edited at all.
- `seatsRequested` cannot be reduced below `seatsFilled`; release a seat first.

**Automatic advances** (attributed to `SYSTEM`, with the triggering actor in
metadata, action `project.status_advanced`):

| Trigger | Advance |
| --- | --- |
| First invitation created | `MATCHING → INVITING` |
| First acceptance | `INVITING → STAFFING` |
| Last seat confirmed | `STAFFING → ACTIVE` |

An advance that would be illegal is skipped silently: the operator's action is
the point, not the status nudge.

**Open for what**

| Operation | Allowed while |
| --- | --- |
| Matching | `MATCHING`, `INVITING`, `STAFFING` |
| Invitations | `MATCHING`, `INVITING`, `STAFFING` |
| Staffing | `INVITING`, `STAFFING`, `ACTIVE` |

---

## Expert

`ExpertStatus`

| From | To |
| --- | --- |
| `PROSPECT` | `ONBOARDING`, `ARCHIVED` |
| `ONBOARDING` | `PENDING_VERIFICATION`, `PROSPECT`, `ARCHIVED` |
| `PENDING_VERIFICATION` | `VERIFIED`, `REJECTED`, `ONBOARDING`, `ARCHIVED` |
| `VERIFIED` | `ARCHIVED`, `ONBOARDING` |
| `REJECTED` | `ONBOARDING`, `ARCHIVED` |
| `ARCHIVED` | `PROSPECT` |

**The gate that matters:** `VERIFIED` is the only status from which an expert
can be staffed, and it is reachable only from `PENDING_VERIFICATION` — which is
only reachable by submitting a complete checklist. There is no path from
`PROSPECT` to `VERIFIED`. An expert cannot be staffed without a human operator
having looked at their submission.

`VERIFIED → ONBOARDING` exists so an operator can reopen someone's checklist
(a renewed attestation, say) without archiving and recreating them.

---

## Invitation

`InvitationStatus`

| From | To |
| --- | --- |
| `DRAFT` | `SENT`, `WITHDRAWN` |
| `SENT` | `ACCEPTED`, `DECLINED`, `EXPIRED`, `WITHDRAWN` |
| `ACCEPTED` | — (terminal) |
| `DECLINED` | `DRAFT` |
| `EXPIRED` | `DRAFT` |
| `WITHDRAWN` | `DRAFT` |

`DRAFT` is the queued state: the operator created it, the worker has not sent it
yet. `DECLINED`, `EXPIRED` and `WITHDRAWN` returning to `DRAFT` is how
re-inviting works — the same row is reopened, so the expert's history with that
project stays in one place.

**Guards**

- One invitation row per `(projectId, expertId)`, enforced by a unique index.
- A second invitation is refused while the existing one is `DRAFT`, `SENT` or
  `ACCEPTED`.
- An archived expert cannot be invited.
- A project with every seat filled cannot take new invitations.
- Responding requires status `SENT` and a deadline in the future.
- Declining requires a reason. An operator withdrawing an invitation requires a
  reason; an expert withdrawing themselves from the project does not.
- Accepting is terminal, so a double-click produces one acceptance.

**On acceptance**, in the same transaction: the invitation becomes `ACCEPTED`,
the expert's onboarding case opens, the expert moves to `ONBOARDING`, an
`onboarding.start` job is queued, and the project advances to `STAFFING`.

---

## Onboarding case

`OnboardingStatus`

| From | To |
| --- | --- |
| `NOT_STARTED` | `IN_PROGRESS` |
| `IN_PROGRESS` | `SUBMITTED` |
| `SUBMITTED` | `VERIFIED`, `REJECTED` |
| `VERIFIED` | — (terminal) |
| `REJECTED` | `IN_PROGRESS` |

**Guards**

- Submission requires every **required** item complete. A refusal lists exactly
  which ones are outstanding, in `error.details.outstanding`.
- A `SUBMITTED` case is locked: the expert cannot edit it while an operator is
  reviewing.
- A `VERIFIED` case is locked permanently.
- A `REJECTED` case reopens to `IN_PROGRESS` as soon as the expert edits an
  answer — otherwise they could save changes but never resubmit them. Reopening
  also moves the expert from `REJECTED` back to `ONBOARDING`.
- Returning a submission requires a written reason.
- The decision is claimed with a conditional update on `status = SUBMITTED`, so
  two operators deciding at once produces one decision.

### The checklist

Six items, fixed template, professional and compliance only:

| Key | Kind | Required |
| --- | --- | --- |
| `profile_confirmed` | attestation | yes |
| `nda_accepted` | attestation | yes |
| `conflict_check` | text | yes |
| `engagement_terms` | attestation | yes |
| `billing_reference` | reference (simulated) | yes |
| `working_notes` | text | no |

No protected personal attribute appears anywhere in it. A unit test asserts this
by word-boundary match against a list of protected terms.

---

## Assignment

`AssignmentStatus`

| From | To |
| --- | --- |
| `PROPOSED` | `CONFIRMED`, `RELEASED` |
| `CONFIRMED` | `RELEASED`, `COMPLETED` |
| `RELEASED` | `PROPOSED` |
| `COMPLETED` | — (terminal) |

**Only `CONFIRMED` and `COMPLETED` consume a seat.** A proposal does not, which
is what lets an operator line up several candidates for one seat and then pick.

**Guards on proposing**

1. Project is `INVITING`, `STAFFING` or `ACTIVE`.
2. Expert is `VERIFIED`. Any other status is refused naming the actual status.
3. Expert has an `ACCEPTED` invitation for this project.
4. Expert has declared availability.
5. Allocation is 1–60 h/week and does not exceed what they declared.
6. One assignment row per `(projectId, expertId)`.

**Guards on confirming** — all inside a transaction holding a `FOR UPDATE` lock
on the project row:

1. Assignment is still `PROPOSED`.
2. Project is still open for staffing.
3. Expert is **still** `VERIFIED` — re-read inside the lock, because
   verification can be revoked between proposal and confirmation.
4. `seatsFilled < seatsRequested`, re-counted inside the lock. Otherwise
   `CAPACITY_EXCEEDED`.

Confirmation then writes the assignment, updates `seatsFilled`, records history
and queues a simulated email — all atomically. The project's advance to `ACTIVE`
happens after the lock is released, so it cannot deadlock against another
confirm.

**Releasing** takes the same lock, recomputes `seatsFilled` from the assignment
table rather than decrementing, requires a reason, and queues a simulated email
only if the seat had actually been confirmed.

**Expert-initiated withdrawal** reuses that release, in one transaction that
also withdraws the accepted invitation, cancels work still waiting on the
expert, stops the reminders attached to that work, records the audit event,
raises the staffing attention item and queues the replacement search. It differs
from an operator release in four ways:

1. **The reason is optional.** Needing an explanation is not a good enough
   reason to keep someone on a project they cannot do. Without one, the release
   reason reads *Expert withdrew (no reason given).*
2. **It is scoped to the expert's own commitment.** An accepted invitation or a
   live assignment on *that* project is required; anything else is refused
   rather than quietly audited. The portal never accepts an expert id from the
   request: it comes from the session.
3. **It is idempotent.** The project row is locked first, so concurrent requests
   queue and the losers return the committed withdrawal unchanged. Repeat clicks
   produce one audit event, one attention item and one replacement job.
4. **It reopens a full project.** A project that had become `ACTIVE` on being
   fully staffed goes back to `STAFFING`, because an `ACTIVE` project accepts no
   invitations and the replacement would otherwise be unreachable.

Work already submitted, approved or paid is never touched. Only `DRAFT`,
`ASSIGNED` and `REVISION_REQUESTED` items are cancelled.

---

## Job

`JobStatus`

| From | To | Cause |
| --- | --- | --- |
| `PENDING` | `RUNNING` | Claimed |
| `RUNNING` | `SUCCEEDED` | Handler returned |
| `RUNNING` | `FAILED` | Handler threw, attempts remain |
| `RUNNING` | `DEAD` | Handler threw, attempts exhausted |
| `FAILED` | `RUNNING` | Backoff elapsed, reclaimed |
| `RUNNING` | `RUNNING` | Lock went stale; another worker reclaimed it |
| `DEAD` / `FAILED` / `CANCELLED` | `PENDING` | Admin retry |

Backoff is `min(2^(attempts-1) × 5s, 600s)`. `attempts` increments on claim, not
on failure, so a job whose worker crashed still counts its attempt and cannot
loop forever.

---

## Outbox message

`OutboxStatus`: `QUEUED → SENT`, with `FAILED` reserved and currently unused.

`SENT` means the worker's `outbox.dispatch` job flipped the row. It does not
mean anything left the machine. Delivery is claimed with a conditional update on
`status = QUEUED`, so overlapping dispatchers deliver each message once.

---

## Where each transition is triggered

| Transition | Trigger | Actor recorded |
| --- | --- | --- |
| Project `DRAFT → MATCHING` | Operator clicks | `OPERATOR` |
| Project `MATCHING → INVITING` | First invitation | `SYSTEM` |
| Project `INVITING → STAFFING` | First acceptance | `SYSTEM` |
| Project `STAFFING → ACTIVE` | Last seat confirmed | `SYSTEM` |
| Project `→ CLOSED` / `CANCELLED` | Operator clicks | `OPERATOR` |
| Invitation `DRAFT → SENT` | Worker `invitation.send` | `SYSTEM` |
| Invitation `SENT → ACCEPTED` / `DECLINED` | Expert in portal | `EXPERT` |
| Invitation `SENT → EXPIRED` | Worker `invitation.expire` | `SYSTEM` |
| Invitation `→ WITHDRAWN` | Operator, with reason | `OPERATOR` |
| Invitation `ACCEPTED → WITHDRAWN` | Expert withdraws in the portal | `EXPERT` |
| Expert `PROSPECT → ONBOARDING` | Acceptance | `EXPERT` |
| Expert `ONBOARDING → PENDING_VERIFICATION` | Checklist submitted | `EXPERT` |
| Expert `PENDING_VERIFICATION → VERIFIED` / `REJECTED` | **Operator decision** | `OPERATOR` |
| Onboarding `NOT_STARTED → IN_PROGRESS` | Acceptance, or first saved answer | `EXPERT` |
| Onboarding `REJECTED → IN_PROGRESS` | Expert edits an answer | `EXPERT` |
| Assignment `→ PROPOSED` | Operator | `OPERATOR` |
| Assignment `PROPOSED → CONFIRMED` | **Operator decision** | `OPERATOR` |
| Assignment `→ RELEASED` | Operator, with reason | `OPERATOR` |
| Assignment `→ RELEASED` | Expert withdraws in the portal | `EXPERT` |
| Project `ACTIVE → STAFFING` | Withdrawal reopened a seat | `SYSTEM` |

The two rows in bold are the human confirmations. Nothing else in the system can
produce them.

---

# Extension state machines

Added by the expert-network extension. The same rule applies: every transition
is declared once in code, and a service refuses anything not in the table.

## Candidate

`CandidateStage`, in `src/server/services/candidates.ts`.

| From | To |
| --- | --- |
| `NEW` | `DUPLICATE_HOLD`, `SCREENING_INVITED`, `REJECTED`, `WITHDRAWN` |
| `DUPLICATE_HOLD` | `NEW`, `WITHDRAWN`, `REJECTED` |
| `SCREENING_INVITED` | `SCREENING_SUBMITTED`, `REJECTED`, `WITHDRAWN` |
| `SCREENING_SUBMITTED` | `IN_REVIEW`, `REVISION_REQUESTED`, `QUALIFIED`, `REJECTED`, `WITHDRAWN` |
| `IN_REVIEW` | `QUALIFIED`, `REJECTED`, `REVISION_REQUESTED`, `WITHDRAWN` |
| `REVISION_REQUESTED` | `SCREENING_SUBMITTED`, `REJECTED`, `WITHDRAWN` |
| `QUALIFIED` | `WITHDRAWN` |
| `REJECTED` | `NEW` |
| `WITHDRAWN` | `NEW` |

`SCREENING_SUBMITTED → QUALIFIED` exists because `grantQualification` accepts a
screening in `SUBMITTED` as well as `IN_REVIEW`. The screening status is the
authority; this table must not contradict it.

**A candidate is not an expert.** Conversion happens inside
`grantQualification`, is logged, and is the only route. Nobody joins the network
by filling in a form.

## Rubric version

| From | To | Notes |
| --- | --- | --- |
| `DRAFT` | `PUBLISHED`, `ARCHIVED` | Editable while DRAFT |
| `PUBLISHED` | `ARCHIVED` | **Immutable.** Criteria, weights and thresholds can never change |
| `ARCHIVED` | — | Terminal |

Editing a published version is refused with a message telling you to create a
new one. A screening keeps the version it started against for ever, which is
what makes an old decision still explainable.

Only one DRAFT may exist per template at a time.

## Screening

| From | To |
| --- | --- |
| `INVITED` | `SUBMITTED`, `EXPIRED`, `WITHDRAWN` |
| `SUBMITTED` | `IN_REVIEW`, `REVISION_REQUESTED`, `DECIDED` |
| `IN_REVIEW` | `REVISION_REQUESTED`, `DECIDED` |
| `REVISION_REQUESTED` | `SUBMITTED`, `EXPIRED` |
| `DECIDED` | — (terminal) |
| `EXPIRED` / `WITHDRAWN` | — |

**Guards**

- A submission is accepted only from `INVITED` or `REVISION_REQUESTED`, and only
  before the deadline. A submitted screening is closed until a reviewer asks for
  changes.
- An incomplete submission is **recorded as incomplete**, not rejected. Missing
  evidence is listed on the submission.
- A decision needs at least one submitted human review.
- A decision is refused while a reviewer conflict is open.

## Screening review

`ASSIGNED → SUBMITTED`, or `ASSIGNED → WITHDRAWN`. Only the assigned reviewer
may submit. Requesting a revision requires feedback the candidate can act on.
`privateNotes` never leave the operator side: candidate-facing views are built
by explicit field selection, so a new column cannot leak by being forgotten.

## Review conflict

`OPEN → RESOLVED`, by an admin, with a required note. Raised automatically when
two submitted reviews disagree. There is no automatic tie-break.

## Qualification

| From | To | Cause |
| --- | --- | --- |
| `ACTIVE` | `NEEDS_REREVIEW` | A project raised its required rubric version |
| `ACTIVE` | `REVOKED` | An operator revoked it, with a reason |
| `NEEDS_REREVIEW` | `ACTIVE` | A human confirmed it still stands |
| `NEEDS_REREVIEW` | `SUPERSEDED` | A human decided it no longer meets the bar |

Raising a project's bar **never** revokes and **never** auto-approves. The
affected qualification keeps its rubric version and its decision history.

## Outreach batch

`DRAFT → PENDING_APPROVAL → APPROVED → DISPATCHED`, with `REJECTED → DRAFT` and
`CANCELLED` as exits.

Dispatch is refused in any state but `APPROVED`. A batch of more than five
recipients cannot be approved by whoever created it.

## Work item

| From | To |
| --- | --- |
| `DRAFT` | `ASSIGNED`, `CANCELLED` |
| `ASSIGNED` | `SUBMITTED`, `CANCELLED` |
| `SUBMITTED` | `IN_REVIEW`, `REVISION_REQUESTED`, `APPROVED`, `CANCELLED` |
| `IN_REVIEW` | `REVISION_REQUESTED`, `APPROVED`, `CANCELLED` |
| `REVISION_REQUESTED` | `SUBMITTED`, `CANCELLED` |
| `APPROVED` | — (terminal) |

A work item can only be created on a `CONFIRMED` seat. Approving sets
`approvedQuantity`, which is the only figure payment preparation reads.

## Support request

`OPEN → WAITING_ON_EXPERT / WAITING_ON_OPS → RESOLVED → CLOSED`.

A public operator reply stops the response clock; an internal note does not.
Resolving clears both blocking flags, because the thing that was stuck no longer
is.

## Payment item

| From | To |
| --- | --- |
| `DRAFT` | `READY` (discrepancy explained), `VOID` |
| `READY` | `IN_BATCH`, `VOID` |
| `IN_BATCH` | `EXPORTED`, `READY` (batch cancelled), `VOID` |
| `EXPORTED` | `VOID` (via correction only) |

There is no `PAID`. Correcting an item moves it to `VOID` and creates a
replacement; the original keeps its figures.

## Payment batch

`DRAFT → PENDING_APPROVAL → APPROVED → EXPORTED`, with `→ DRAFT` on a
correction and `CANCELLED` as an exit.

Approval is refused for the operator who created the batch. Export is refused in
any state but `APPROVED`.

## Offboarding task

`PENDING → CONFIRMED` or `PENDING → NOT_APPLICABLE`, both requiring a note.
Neither means the system checked anything.

## Attention item

`OPEN → RESOLVED` (automatic, when the condition clears) or `OPEN → DISMISSED`
(an operator, with a reason). A `RESOLVED` item reopens if the condition recurs;
a `DISMISSED` one stays dismissed until it resolves and then recurs.
