# Architecture

## The shape of the thing

ExpertOps is a Next.js application and a worker process sharing one PostgreSQL
database and, more importantly, one set of business services.

```
┌──────────────────────────┐      ┌──────────────────────────┐
│  Next.js app (port 3000) │      │  Worker process          │
│                          │      │                          │
│  Server components  ─────┼──┐   │  Job handlers  ──────────┼──┐
│  Route handlers     ─────┼──┤   │  Scheduler tick          │  │
└──────────────────────────┘  │   └──────────────────────────┘  │
                              │                                 │
                              ▼                                 ▼
                     ┌─────────────────────────────────────────────┐
                     │  src/server/services/*                      │
                     │  the only place business rules exist        │
                     └─────────────────────────────────────────────┘
                                          │
                                          ▼
                     ┌─────────────────────────────────────────────┐
                     │  Prisma  →  PostgreSQL 16                   │
                     │  domain tables · job queue · schedules      │
                     │  activity history · simulated outbox        │
                     └─────────────────────────────────────────────┘
```

## Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| Pure domain | `src/server/domain/` | Scoring and state machines. No I/O, no clock, no randomness. |
| Services | `src/server/services/` | Every business rule. Takes a database handle, returns domain objects, throws `AppError`. |
| HTTP adapter | `src/server/http/` | Cookies to actors, `AppError` to status codes, Zod to request shapes. |
| Route handlers | `src/app/api/**` | Authorise, parse, call one service, return. |
| Server components | `src/app/(operator)/**`, `src/app/portal/**` | Read through services, render. |
| Worker | `src/server/worker/` | Claim jobs, call the same services. |

### One rule, one place

This is the constraint the whole layout exists to satisfy: **a UI action and the
equivalent worker action run the same code.**

Sending an invitation is the clearest example. `POST /api/projects/:id/invitations`
creates the invitation and enqueues a job. The worker's `invitation.send`
handler picks it up and calls `sendInvitation`. Both paths go through
`src/server/services/invitations.ts`. Neither re-checks whether the project is
open for invitations, whether the expert is archived, or whether a seat is left
— the service owns all of that.

The same holds for verification (`decideVerification`), staffing
(`proposeAssignment` / `confirmAssignment`), matching (`runMatching`) and
onboarding (`startOnboarding`). A worker handler is a payload parser and one
service call; a route handler is an authorisation check, a Zod parse, and one
service call.

State transitions are narrower still. Every legal transition is declared once
in `src/server/domain/state-machines.ts` and checked by `assertTransition`.
Changing a rule means changing that table, and both callers follow.

### Service signatures

Services take `Db`, which is a Prisma client **or** a transaction handle:

```ts
export async function createInvitation(db: Db, actor: Actor, input: CreateInvitationInput)
```

This lets a caller compose several services into one transaction. The seed, the
worker and the HTTP layer all pass the shared client; tests pass whatever they
need.

Services that require a row lock take `Transactor` instead, because the lock and
the write must be in the same transaction to mean anything:

```ts
export async function confirmAssignment(client: Transactor, actor: Actor, assignmentId: string)
```

### Actors

Every service that writes history takes an `Actor`: `OPERATOR` (with a user id),
`EXPERT` (with an expert id), or `SYSTEM`. The HTTP layer builds it from the
session cookie; the worker uses `SYSTEM_ACTOR`. That is why the activity screen
can honestly say who did what.

A workflow step that happens as a side effect of another — a project advancing
from `INVITING` to `STAFFING` when an expert accepts — is attributed to `SYSTEM`
with the triggering actor recorded in metadata. Nobody chose to move the
project; the workflow did.

## Data model

Twenty tables. The ones that carry the workflow:

- **User / Session** — operators and their cookie sessions.
- **Expert / Skill / ExpertSkill** — the network and what it knows.
- **ExpertPortalToken / ExpertPortalSession** — magic links and portal sessions.
- **Project / ProjectSkillRequirement** — engagements and what they need.
- **MatchRun / MatchCandidate** — an immutable, explainable ranking snapshot.
- **Invitation** — one row per (project, expert) pair, reopened rather than duplicated.
- **AvailabilityWindow** — what an expert offers.
- **OnboardingCase / OnboardingItem** — the checklist and its human decision.
- **Assignment** — a seat, and whether it is consumed.
- **ActivityEvent** — append-only history.
- **OutboxMessage** — the simulated outbox.
- **Job / Schedule** — the queue and its cron.

Money is stored in minor units everywhere. Times are `timestamptz`.

### Design decisions worth naming

**`Project.seatsFilled` is denormalised.** It is maintained inside the same
transaction that confirms or releases an assignment, under a row lock on the
project, and is recomputed from the assignment table rather than incremented
blindly. That makes it trustworthy enough to be the capacity guard and cheap
enough to read on every list page.

**`Invitation` is unique on `(projectId, expertId)`.** Re-inviting someone
reopens the existing row instead of creating a second one, so an expert's
history with a project stays in one place. The unique index is also what turns
two simultaneous invite clicks into one invitation and one `CONFLICT`.

**`MatchRun.params` snapshots the weights and criteria.** A run stays
explainable after the project requirements change underneath it.

**`Job.dedupeKey` is a unique index.** "Enqueue this once" is a database
guarantee, not an application convention.

**`ActivityEvent` denormalises `projectId` and `expertId`.** A project or expert
timeline is then a single index read.

## Matching

`src/server/domain/matching-engine.ts` is pure: no database, no clock (the
caller passes `now`), no randomness. The same inputs always produce the same
ranking.

Two stages:

1. **Hard exclusions** (`evaluateExclusion`) — archived or rejected status, a
   missing required skill, proficiency below the minimum, below the experience
   bar, already invited or assigned to this project, or inside the 14-day
   cool-off after declining. Excluded experts are still recorded on the run with
   their reason, so an operator can see who was skipped and why rather than
   wondering where someone went.

2. **Weighted scoring** (`scoreCandidate`) — six components:

   | Component | Default weight | Measures |
   | --- | --- | --- |
   | Required skills | 35 | Depth beyond each minimum, weighted per requirement |
   | Optional skills | 20 | Coverage of nice-to-haves |
   | Seniority | 15 | Experience against the bar |
   | Rate | 12 | Full marks at or under the ceiling, decaying to zero at 25% over |
   | Availability | 10 | Working-hours overlap (60%) and declared capacity (40%) |
   | Standing | 8 | Lifecycle position, reduced when already holding seats |

   The result is normalised to 0–100 and rounded. Ties break on expert id, so
   two runs over the same data always produce the same order.

`runMatching` in the service layer loads the pool, hands it to the engine, and
persists the result. It is called identically from the UI and from the
`matching.run` job.

No language model, no external API, no protected personal attribute is involved.

## The job queue

PostgreSQL-backed, no separate broker. All state lives in the `Job` and
`Schedule` tables, so a worker holds nothing of its own and can be killed and
restarted at any point.

### Claiming and ownership

```sql
UPDATE "Job" AS j
SET "status" = 'RUNNING', "lockedBy" = worker,
    "claimId" = gen_random_uuid()::text, "leaseExpiresAt" = now + lease,
    "attempts" = attempts + 1
FROM (
  SELECT "id" FROM "Job"
  WHERE "attempts" < "maxAttempts"
    AND (("status" IN ('PENDING','FAILED') AND "runAt" <= now)
      OR ("status" = 'RUNNING' AND "leaseExpiresAt" < now))
  ORDER BY "priority", "runAt", "createdAt"
  LIMIT n
  FOR UPDATE SKIP LOCKED
) AS candidate
WHERE j."id" = candidate."id"
RETURNING ...
```

`FOR UPDATE SKIP LOCKED` is what lets N workers share one table without ever
being handed the same row in a single moment. The expired-lease clause is crash
recovery, which is why `attempts` increments on claim rather than on failure: an
abandoned attempt costs exactly what a failed one costs.

Two workers can still end up believing they own the same job, because a lease
has to expire eventually or a crashed worker would block it forever. What must
never happen is that both of them *act* on it. Three mechanisms, and no one of
them is sufficient alone:

**A fencing token.** Every claim mints a new `claimId`. It is required to renew
the lease, to complete, and to fail. A worker whose job was taken over still
holds the old value, so each of those matches zero rows and it is told it has
lost the job.

**A bounded lease with renewal.** `leaseExpiresAt` is renewed on a heartbeat
while a handler runs, on a connection outside the execution transaction so other
workers see it immediately. A legitimately slow handler is therefore never taken
over. The lease is also renewed once *before* starting, because a job claimed in
a batch may wait behind several others and reach the front with its lease nearly
spent; if that renewal fails, the handler is not run at all.

**The effects live inside the claim.** The handler and its completion run in one
transaction. If the ownership check at completion finds the claim gone, the
transaction throws and every write the handler made rolls back with it. This is
what stops a stale worker leaving a duplicate outbox message behind. It is also
why `HandlerContext.client` is a `Db` and not a `Transactor`: a handler must not
open a transaction of its own and commit outside this one.

### Execution guarantees

**At-least-once execution. At-most-once *committed database effect* per claim.**

The second half of that sentence is deliberately narrow, and the narrowness is
the point.

A handler may *run* more than once. A worker that stalls past its lease can have
its job taken over, and both processes may execute concurrently. What cannot
happen is both committing: the loser's completion matches no row, its
transaction rolls back, and its writes disappear with it.

That works because the effect and the proof of the effect are the same
transaction in the same database. Every effect in this build is a row —
simulated outbox messages, invitations, activity entries, attention items,
payment items. Nothing leaves the process.

**What this does not give you.** Transactional fencing cannot undo anything that
already happened outside the database. If a future handler sends a real email,
charges a card, or calls any external API, that call is made the moment it is
made; a rollback afterwards removes the record of it and leaves the side effect
standing, which is worse than not rolling back at all. Adding such a handler
means adding an idempotency mechanism the remote side honours — an idempotency
key, a provider-side deduplication window, or an outbox row that is marked sent
only after a confirmed response — and none of that exists here, because no such
handler exists here.

So the guarantee to carry forward is: *this build's effects are database writes,
and fencing makes those exactly-once per claim.* It is not a general
exactly-once delivery guarantee, and it should not be quoted as one.

Two further caveats. A handler that opened and committed its own transaction
would escape the fence entirely, which is why `HandlerContext.client` is typed
`Db` rather than `Transactor`. And the execution transaction is bounded by the
lease, so a handler that needs longer than its lease fails rather than commits.

Recovery is bounded at both ends. The claim query requires `attempts <
maxAttempts`, so a job whose worker is killed on every attempt stops being
offered rather than looping forever. `reapAbandonedJobs`, which runs at the end
of each tick, then releases an expired claim that still has attempts left or
declares it `DEAD` when it does not — closing the case where nobody is left
alive to call `failJob`.

### Retries

Failure records the error, sets `status = FAILED`, and schedules a retry with
exponential backoff capped at ten minutes. Once `attempts` reaches
`maxAttempts` the job becomes `DEAD` and stops being claimed. An admin can
retry it from the Worker screen.

### Scheduling

A `Schedule` row is a job type, an interval, and a `nextRunAt`. Each tick claims
due schedules with the same `FOR UPDATE SKIP LOCKED` pattern and advances
`nextRunAt` in the same statement. Enqueued jobs carry a dedupe key derived from
the schedule name and the current second, so even a double claim produces one
job.

Claiming a schedule and creating its job are **one transaction**, one schedule
at a time. If the enqueue fails, the claim rolls back with it and the schedule
is still due, so the next tick retries it. Splitting them meant a failed enqueue
silently consumed the execution: the schedule looked as though it had run and
nothing would happen until the next interval. One schedule at a time, rather
than the whole batch in one transaction, so a single broken schedule cannot
stall the others.

`nextRunAt` is set from *now* rather than from the previous `nextRunAt`. A
worker that was offline for an hour fires each schedule once on restart instead
of replaying a backlog.

Registered schedules:

| Name | Every | Does |
| --- | --- | --- |
| `outbox-dispatch` | 15s | Marks queued simulated emails delivered |
| `invitation-expire` | 60s | Closes invitations past their deadline |
| `invitation-remind` | 300s | One reminder per open invitation after 24h |
| `onboarding-nudge` | 600s | Nudges stalled checklists |
| `maintenance-sweep` | 3600s | Purges expired sessions and old finished jobs |

### The run loop

`Worker.tick()` advances the scheduler, claims a batch, and runs each job. It
sleeps only when a tick claimed nothing, so a full batch means more work is
waiting. `tick()` is what the tests drive directly; `start()` is the loop around
it.

### History retention

The `Job` table grows by roughly one row per schedule per tick — a few thousand
rows a day at the intervals above. `maintenance-sweep` prunes it hourly, and the
policy is deliberately narrow:

| Status | Retained |
| --- | --- |
| `SUCCEEDED`, `CANCELLED` | Until `finishedAt` is older than seven days |
| `FAILED`, `DEAD` | Indefinitely — a failure is evidence |
| `PENDING`, `RUNNING` | Never pruned; they are live |

Pruning frees the `dedupeKey` of any row it removes, so what may be pruned is
decided by an explicit `dedupeScope` on the row rather than inferred from the
shape of the key:

| Scope | Meaning | Examples |
| --- | --- | --- |
| `DISPOSABLE` | The key provably cannot recur | `schedule:<name>:<bucket>`, `invitation.send:<id>:<ms>` |
| `DURABLE` (default) | The key *is* the record that a business event happened | `onboarding.start:<invitationId>`, `payment.draft:<reviewId>`, `screening.invite:<id>:<revision>` |

An earlier version of this document claimed every key in use was time-scoped and
therefore safe to free. That was wrong. `onboarding.start:<invitationId>` and
most other business keys carry no time component at all, and the handler behind
that one issues a fresh portal token and queues another onboarding email on
every run — so freeing the key re-armed a duplicate email and a second live
magic link.

The default is `DURABLE` on purpose: a caller who says nothing gets retention,
because a freed key fails silently and only shows up as a duplicate effect.
Pinned by `dedupe-retention.test.ts`, which replays a real `onboarding.start`
after a real maintenance sweep and asserts the outbox and token counts do not
move.

The growth this accepts is one retained row per business event, which is
business volume rather than tick frequency. The Worker screen shows the split
between prunable history, rows kept for deduplication, and failures.

Nothing prunes activity history, outbox messages, or any business record. Job
rows are the only thing this build deletes on a schedule.

One subtlety worth recording, because it was a real bug caught in testing: the
poll timer must **not** be `unref`'d. It is the only thing keeping the event
loop alive between ticks, and unref'ing it made the worker process exit silently
after its first idle tick. Three tests now assert the loop stays up, picks up
work enqueued while idling, and stops promptly.

## Concurrency

Three mechanisms, chosen per situation.

**Row locks, for capacity.** `confirmAssignment` opens a transaction, takes
`SELECT ... FOR UPDATE` on the project row, re-counts seats inside the lock, and
only then writes. Concurrent confirmations queue behind the lock; the one that
would exceed capacity is rejected with `CAPACITY_EXCEEDED`. This is the only
place a lock is needed, because it is the only place where a stale read causes
real damage.

**Conditional updates, for state transitions.** Answering an invitation,
deciding a verification case, redeeming a portal link, expiring an invitation,
sending a reminder — all use `updateMany` with the expected current state in the
`where` clause and check `count`. If it is zero, somebody else got there first
and the caller gets a clear domain error. Cheaper than a lock and sufficient
when the only risk is a duplicate transition.

**Unique constraints, for identity.** One invitation per (project, expert), one
job per dedupe key, one onboarding case per expert. Races become
`P2002`, which services translate into `CONFLICT`.

History entries are written inside the caller's transaction, so a step that
rolls back takes its history and its queued email with it. A test asserts this
for the losing side of a seat race.

## Authentication and access control

**Operators** sign in with email and password. Passwords are bcrypt (pure JS, so
`npm install` needs no native toolchain). Sessions are opaque random tokens in
an httpOnly cookie; only an HMAC of the token is stored, so a database dump
cannot be replayed as a session. Login runs a bcrypt comparison even for an
unknown email, so response timing does not reveal which accounts exist.

**Experts** have no password. They receive a single-use magic link in a
simulated email, which is exchanged for a portal session. Redemption marks the
token used in the same transaction, so a forwarded link cannot open a second
session.

**Authorisation** is capability-based. Eighteen capabilities, three roles, one
table in `src/server/auth/permissions.ts`. Guarded actions name a capability
rather than testing a role inline:

```ts
const { actor } = await requireCapabilityFromRequest(request, 'staffing:confirm');
```

Route handlers read cookies from the request rather than from async storage,
which is what lets the API tests construct a `NextRequest` and call the exported
handler directly with no server running.

## Error handling

Services throw `AppError` with a domain code. `src/server/http/respond.ts` is the
single place those become status codes:

| Code | Status |
| --- | --- |
| `BAD_REQUEST` | 400 |
| `UNAUTHENTICATED` | 401 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `CONFLICT`, `INVALID_STATE`, `CAPACITY_EXCEEDED` | 409 |
| `INTERNAL` | 500 |

Messages are written once, in the service that owns the rule, and reach the user
unchanged. The UI renders whatever the server said rather than deciding for
itself whether an action was allowed. `INVALID_STATE` carries the allowed
transitions in `details`; `CAPACITY_EXCEEDED` carries the seat counts.

## Testing strategy

Three layers, matching the code layers.

**Unit** — the pure domain and small utilities. No database, fast.

**API** — exported route handlers called directly with a constructed
`NextRequest`, against a real database. Covers authorisation, validation, status
codes, and cookie handling.

**Integration** — services, the worker, and concurrency, against a real
PostgreSQL. Concurrency tests use additional Prisma clients on separate
connections so the races are genuine rather than interleaved inside one pool
slot.

`fileParallelism` is off: the suites share one test database and truncate
between cases. Migrations are applied once per process.

---

# Extension architecture

The expert-network extension follows the same layering. Twenty-eight new tables,
thirteen new services, one new pure-domain module, and no new patterns.

## What changed structurally

**The automation map became data.** `src/server/domain/automation.ts` declares
every event-driven workflow, approval gate and reminder rule as a typed
constant. `docs/automation.md` describes the same table, and the UI reads the
approval gates from it. There is one place to change a rule.

**Time became injectable.** `src/lib/clock.ts` provides the ambient clock that
services and handlers read. `src/lib/time.ts` defaults every helper to it, so
most code needed no change. Tests and `scripts/demo.ts` install a `FixedClock`
and advance it explicitly; `setAmbientClock` throws in a production build, and
nothing reachable over HTTP can call it.

**CSRF moved into the request guards.** `requireOperatorFromRequest` and
`requireExpertFromRequest` check origin and a double-submit token before
returning. A new endpoint is protected by virtue of requiring a session, rather
than by remembering to add a check. Login and magic-link redemption are checked
explicitly, since they create sessions without holding one.

The token is minted in Edge middleware and verified on Node, so there are two
HMAC implementations. `csrf-edge.ts` uses Web Crypto, `csrf.ts` uses
`node:crypto`, and a test asserts they produce identical digests — if they ever
diverged, every mutation would break.

## New services

| Service | Owns |
| --- | --- |
| `attention` | The exception queue: raise, refresh, resolve, dismiss |
| `candidates` | Intake pipeline, applications, duplicate detection |
| `sourcing` | Campaigns and source-channel effectiveness |
| `screening` | Templates, immutable rubric versions, submissions, reviews, conflicts |
| `qualifications` | Qualification records, project requirements, re-review |
| `staffing-gaps` | Gap detection, readiness blockers, withdrawal, replacement |
| `outreach` | Batches and the human approval gate before dispatch |
| `work` | Work items, submissions, reviews |
| `support` | Requests, replies, blocking flags |
| `payments` | Draft items, discrepancies, batches, corrections, export |
| `offboarding` | Checklists and human confirmations |
| `candidate-portal` | Magic links and sessions for candidates |
| `expert-import` | CSV preview, commit and export |

## Money

`src/lib/decimal.ts` is the only place arithmetic happens. Money is an integer
count of minor units; quantities are scaled integers at two decimal places. The
product of two integers is exact, and only the final division rounds, half-up.

The module refuses a non-integer rate or an unscaled quantity rather than
coercing, so a floating-point value cannot enter by accident. `sumMinor` refuses
non-integers and guards the safe-integer range.

## CSV

`src/lib/csv.ts` neutralises every cell before quoting. A value beginning with
`=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with an apostrophe,
which every major spreadsheet reads as "this is text". Control characters are
stripped first, so a leading NUL cannot hide a trigger from the check.

The parser handles quoted fields, embedded commas, doubled quotes and both line
endings, and reports a row with the wrong column count rather than guessing.

## The attention queue

The design constraint was that an operator should be able to trust an empty
list. That produces three rules, all enforced in the service:

- **One row per condition**, keyed on what is stuck rather than when it was
  noticed, so a two-minute sweep does not produce thirty rows an hour.
- **Self-resolving**, including for records that leave the scanned set entirely.
  An early version orphaned items when a project filled and became `ACTIVE`;
  the sweep now closes anything whose project is no longer in scope.
- **Structurally actionable.** `blocker`, `impact` and `nextAction` are required
  fields, so an item that cannot explain itself cannot be created.

## Reference allocation

Human-facing references (`EXP-0001`, `SCR-0004`) are allocated by scanning only
references that match the expected shape. An earlier version took the lexical
maximum, which meant a single record with a different shape — from a test
factory or an import — sorted highest and silently reset the counter to 1,
colliding on the next insert. That bug is why `uniqueViolationTarget` exists:
the handler now reports which column actually collided.
