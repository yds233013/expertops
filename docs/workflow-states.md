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
- Declining requires a reason. Withdrawing requires a reason.
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
| Expert `PROSPECT → ONBOARDING` | Acceptance | `EXPERT` |
| Expert `ONBOARDING → PENDING_VERIFICATION` | Checklist submitted | `EXPERT` |
| Expert `PENDING_VERIFICATION → VERIFIED` / `REJECTED` | **Operator decision** | `OPERATOR` |
| Onboarding `NOT_STARTED → IN_PROGRESS` | Acceptance, or first saved answer | `EXPERT` |
| Onboarding `REJECTED → IN_PROGRESS` | Expert edits an answer | `EXPERT` |
| Assignment `→ PROPOSED` | Operator | `OPERATOR` |
| Assignment `PROPOSED → CONFIRMED` | **Operator decision** | `OPERATOR` |
| Assignment `→ RELEASED` | Operator, with reason | `OPERATOR` |

The two rows in bold are the human confirmations. Nothing else in the system can
produce them.
