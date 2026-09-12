# Independent review: findings and repairs

What the review at `1d34bbc` found, how each defect was reproduced, what was
changed, and what the tests actually demonstrate. Anything still true after the
repair is in *Remaining limitations* at the end rather than left implied.

---

## 1. Access tokens in initial request URLs

### Reproduced

The landing page was `/apply/enter/<token>`. Requesting one and reading the
server's own request log. Every token-shaped string quoted in this document is a
synthetic probe value invented for the reproduction — `REPRO-…` and `ZZ-…` were
never valid credentials and redeem nothing:

```
GET /apply/enter/REPRO-F1-DISTINCTIVE-TOKEN-9f3a7c21e5 200 in 328ms
GET /portal/enter/REPRO-F1-DISTINCTIVE-TOKEN-9f3a7c21e5 200 in 2038ms
```

Both audiences leaked. The POST exchange protected the *second* request, and
`router.replace` cleaned the address bar, but neither removes a line already
written. Any proxy, CDN or hosting access log in front of the application would
have captured the same path.

### Repaired

The token moved into the URL **fragment**, which browsers do not transmit:

```
http://localhost:3000/apply/enter#t=<token>
```

`buildCandidatePortalUrl` and `buildPortalUrl` now emit that form, the
token-bearing dynamic routes are gone, and `/apply/enter` and `/portal/enter`
read the fragment client-side, strip it with `replaceState`, and exchange it
through the existing `POST /api/apply/session` and `POST /api/portal/session`.
`Referrer-Policy: no-referrer` is set on both portal trees, with
`strict-origin-when-cross-origin` elsewhere.

Everything the review asked to preserve is unchanged: expiry, revocation, the
single-use burn inside the claiming statement, CSRF on the exchange, and the
session scoping that stops one candidate reading another's application.

### Verified

Driving a real browser to `/apply/enter#t=ZZ-BROWSER-PROOF-TOKEN-4d9e21ab7c`,
the server logged:

```
GET /apply/enter 200 in 1589ms
POST /api/apply/session 401 in 789ms
```

and the token appears nowhere in the log. `tests/integration/token-exposure.test.ts`
asserts the property at its source — that the transmitted part of every issued
link contains no token, for both audiences, including a token containing `?`
and `#`.

The 401 rather than a 403 also shows the CSRF guard still passes under
`no-referrer`: the browser still sends `Origin` on a same-origin POST.

**Not claimed.** This is not a claim based on clearing browser history or on
request logging being off. It rests on the fragment never being sent. Links
already issued in the old format no longer work; a new link must be issued.

---

## 2. Worker ownership and recovery

### Reproduced

Against the code at `1d34bbc`, replaying its exact claim and completion
statements:

```
worker-A claimed:            1 job(s)
worker-B ALSO claimed:       1 job(s)  <-- both workers now hold it
recorded result:             {"by":"worker-A","stale":true}  <-- stale worker won
claim at attempts=9/max=3:   1 job(s)  <-- recovery was unbounded
```

Three defects. A RUNNING job was reclaimed once `lockedAt` aged out even though
the first worker was still executing. `completeJob` and `failJob` updated by job
id alone, so whichever worker finished last decided the recorded outcome. And
stale recovery ignored `maxAttempts` entirely, so a job whose worker was killed
every time could be retried forever.

### Repaired

Three protections, because no one of them is sufficient.

**A fencing token.** Every claim mints a new `claimId`. It is required to renew
the lease, to complete, and to fail. A worker that lost its job still holds the
old value, so each of those operations matches zero rows and reports the loss.

**A bounded lease with renewal.** `leaseExpiresAt` replaces the aged-lock check.
The worker renews it on a heartbeat while a handler runs, on a connection
outside the execution transaction so the renewal is immediately visible to other
workers. A legitimately slow handler is therefore never taken over. It also
renews *once before starting*, which covers a job claimed in a batch that waits
behind several others and reaches the front with its lease nearly spent; if that
renewal fails, the handler is not run at all.

**Business effects inside the claim.** The handler and its completion run in one
transaction. If the ownership check at completion finds the claim gone, the
transaction throws and every write the handler made rolls back with it. This is
what stops a stale worker leaving a duplicate outbox message behind.

Recovery is bounded at both ends: the claim query requires `attempts <
maxAttempts`, and `reapAbandonedJobs` releases an expired claim that still has
attempts left or declares it DEAD when it does not.

### Execution guarantees, stated accurately

**At-least-once delivery, at-most-once committed effect per claim.** A handler
may *run* more than once: a worker that stalls past its lease can have its job
taken over and both may execute concurrently. What cannot happen is both
committing. The loser's completion matches no row, its transaction rolls back,
and its writes disappear.

This holds for effects written through the handler's transaction, which is every
effect in this build — outbox rows, invitations, activity entries, attention
items are all database writes. It would not hold for an effect outside the
database, and there are none.

Two honest caveats. A handler that commits its own transaction internally would
escape this, which is why `HandlerContext.client` is typed `Db` rather than
`Transactor`. And the transaction is bounded by the lease duration, so a handler
that runs longer than its lease will fail rather than commit.

### What the tests demonstrate

`tests/integration/worker-ownership.test.ts`, real PostgreSQL, separate
connections per worker:

| Test | Demonstrates |
| --- | --- |
| Two workers competing for one job | Exactly one claim is granted |
| A slow handler past its original lease | Renewal keeps it; a second worker is refused at every point during a run four times the lease |
| Recovery after an abandoned claim | Reclaimed with a *different* fencing token, attempts incremented |
| A stale worker completing, failing, renewing | All three refused; status, error and result unchanged; the rightful owner still succeeds |
| A stale worker's business effects | The outbox row it wrote is gone after the rollback; the job still belongs to the taker |
| Two workers racing one job | One success, and exactly one outbox row however many handlers ran |
| Repeated abandoned claims | Offered exactly `maxAttempts` times, then refused, then declared DEAD with the reason |
| A job stolen while queued behind another | Its handler never runs in the losing worker |

---

## 3. State, audit and job scheduling atomicity

### Reproduced

Every outreach operation wrote business state and its activity entry as separate
statements. Injecting a failure on the audit write with a temporary database
constraint left a batch that had moved status with no record of who moved it.
Dispatch was worse: every error, including an infrastructure fault, was written
into `skippedReason` and the recipient dropped permanently, and the batch was
then marked DISPATCHED regardless.

### Repaired

`createBatch`, `submitBatchForApproval` and `decideBatch` each run in one
transaction covering the state change and its activity entry. They take a
`MaybeTransactor` and use the new `withTransaction` helper in `src/lib/db.ts`,
which joins a transaction that is already open — so the same service is atomic
whether called from a route handler or from inside a worker job.

Dispatch commits **per recipient**, deliberately: one transaction for a hundred
invitations would mean one failure discarding ninety-nine successes. Each
recipient's invitation, its activity entry and the item's new state commit
together or not at all.

`OutreachBatchItem` gained `dispatchState`, `attempts`, `lastError` and
`dispatchedAt`. The distinction that matters:

- **SKIPPED** — a business rule refused this person (archived, already invited,
  no seats left). A decision, permanent, not reconsidered on a retry.
- **FAILED** — an infrastructure fault. Says nothing about eligibility, so the
  row stays retryable.

The rule is mechanical: an `AppError` is the domain saying no; anything else is
the machinery failing.

A batch with retryable recipients lands in the new `PARTIALLY_DISPATCHED`
status, not `DISPATCHED`. Dispatch can be called again and picks up exactly the
outstanding rows; a repeated request against a finished batch is a no-op that
reports what was already sent rather than an error.

### What the tests demonstrate

`tests/integration/outreach-atomicity.test.ts` injects real failures with
temporary constraints rather than mocking:

| Test | Demonstrates |
| --- | --- |
| Audit write fails during creation | No batch and no items survive |
| Audit write fails during submission | Status stays DRAFT; the retry leaves exactly one audit entry |
| Audit write fails during approval | Status stays PENDING_APPROVAL with no approver recorded |
| Invitation table broken | All recipients FAILED, none SKIPPED, batch PARTIALLY_DISPATCHED, `dispatchedAt` null; the retry invites all three exactly once |
| One recipient archived | That row SKIPPED with the reason; the others invited; a second dispatch does not reconsider it |
| Repeated and concurrent dispatch | Three invitations total, three `invitation.created` events |
| `invitation.created` audit write fails | Zero orphaned invitations; the attempt count survives the rollback |

---

## 4. Scheduler atomicity

### Reproduced

`tickSchedules` advanced `nextRunAt` in one statement and enqueued the job in
another. A failure in between consumed the scheduled execution: the schedule
looked as though it had run, no job existed, and nothing would happen until the
next interval.

### Repaired

Claiming a schedule and creating its job are one transaction, one schedule at a
time so a single broken schedule cannot stall the rest. A rolled-back claim
leaves `nextRunAt` where it was, so the schedule is still due and the next tick
retries it. `TickResult` now reports `failed` alongside `enqueued`.

### What the tests demonstrate

`tests/integration/scheduler-atomicity.test.ts`:

| Test | Demonstrates |
| --- | --- |
| Enqueue fails | No job, `nextRunAt` unmoved, `lastJobId` null; the next tick does the work |
| Four workers ticking the same instant | Exactly one job, advanced exactly one interval |
| Normal tick | `lastJobId` points at the job created in the same transaction |
| Restart recovery | A schedule left due fires once, and only once |
| One broken schedule among two | The other still fires; the broken one stays due |

---

## 5. Bulk outreach in the UI

Previously there was no interface at all: assembling, submitting, approving and
dispatching a batch were API-only.

Added `/outreach` and `/outreach/[batchId]`:

- **Select and preview.** Recipients come from the project's latest match run,
  so this is not a second ranking implementation. People who cannot currently be
  invited are listed with the reason rather than filtered out.
- **Submit for approval**, `outreach:write`.
- **Approve or reject**, `outreach:approve`, with the rejection note the service
  already required. The self-approval rule above `SELF_APPROVAL_LIMIT` is
  unchanged.
- **Dispatch**, `outreach:approve`, labelled with how many recipients it would
  act on, and reading "Retry N recipients" on a partially dispatched batch.
- **Per-recipient results**: state, attempts, invitation, skip reason, and the
  retryable error where there is one.
- **Replacement batches** the worker assembled appear in the same list, marked
  as such, and need the same human approval.

Everything goes through the existing services, so there is no second invitation
implementation.

`tests/e2e/outreach.spec.ts` walks it in a browser: preview (asserting nothing
was sent), submit, an operator without the capability seeing no approve control,
approval by a second admin, one recipient archived between approval and
dispatch, the per-recipient result, and a repeated dispatch that invites nobody
twice.

---

## 6. Small operations gaps

**Offboarding ownership.** Automatic creation is unchanged. Checklists opened by
the worker have no owner, because the worker is not a person who can be
accountable for one — so instead of guessing, they now sit in a visible
unassigned queue on the Delivery screen, counted and highlighted, with an owner
control on each row. `assignOffboardingTask` records the change in the activity
history and is gated by a new `offboarding:assign` capability.

**"It ran" versus "it did something".** `{"attempted":0,"delivered":0}` beside a
green success badge reads as delivered email. `src/lib/job-outcome.ts` describes
what a finished job actually did — "ran, nothing to do" against "3 delivered" —
and the worker screen's column is now headed *What it did*. Nothing about the
worker changed; only what the operator is told. Delivery remains simulated
throughout: "delivered" means a row in the in-app outbox was marked, never that
a message left the machine.

**Job history retention.** Documented in `docs/architecture.md` and pinned by
tests. The policy: `maintenance.sweep` runs hourly and prunes only SUCCEEDED and
CANCELLED jobs whose `finishedAt` is older than seven days. FAILED and DEAD jobs
are never pruned by age, because a failure is evidence. Nothing was deleted as
part of this repair.

---

## Remaining limitations

- **Links issued before this change no longer work.** They pointed at routes
  that no longer exist. A new link has to be issued. Tokens already written into
  a development log stay there; nothing can retract them.
- **A handler can still run twice.** Only one execution can commit. If a future
  handler reaches outside the database, that guarantee does not extend to it.
- **The execution transaction is bounded by the lease.** A handler that needs
  longer than its lease will fail rather than commit. The lease is configurable;
  no handler in this build comes close.
- **`reapAbandonedJobs` runs once per worker tick**, after the batch. A single
  worker that is down entirely does not sweep; another worker, or its own
  restart, does.
- **Outreach recipients come from the latest match run only.** There is no way
  to add somebody by hand who was not ranked, and no way to move a recipient
  between batches.
- **Offboarding tasks still cannot be created or reopened from the UI** — only
  assigned and confirmed. Creation remains automatic on project closure.
- **`describeJobOutcome` recognises counter names**, so a handler that invents a
  new one reports "unknown" rather than a wrong summary. That is the intended
  failure mode, but it does mean the column is silent for unrecognised results.
- **No load testing.** Concurrency is tested for correctness with a handful of
  simultaneous workers, not under sustained load.
