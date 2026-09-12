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

**At-least-once execution. At-most-once *committed database effect* per claim.**
A handler may *run* more than once: a worker that stalls past its lease can have
its job taken over and both may execute concurrently. What cannot happen is both
committing. The loser's completion matches no row, its transaction rolls back,
and its writes disappear.

This holds because the effect and the proof of it are the same transaction in
the same database. Every effect in this build is a row. Fencing cannot undo a
real email, a payment call or any other request that has already left the
process; a rollback there removes the record and leaves the side effect
standing. See *Worker guarantees, stated narrowly* at the end of this document.

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

## Second review round

Four further findings against `4872981`. Same discipline: reproduced, repaired,
regression-tested.

---

### 7. Business-event deduplication lost to pruning

**Reproduced.** Replaying the pruning rule as it stood:

```
enqueued business event:      onboarding.start:inv-repro-0001
second enqueue:               refused by the unique index — correct
maintenance sweep pruned:     1 job(s)
replay of the same event:     CREATED  <-- no longer deduplicated
```

`pruneFinishedJobs` deleted any old SUCCEEDED or CANCELLED job and freed its
`dedupeKey` with it. For a key that identifies a business event rather than a
scheduler tick, the key *is* the record that the event happened. The
`onboarding.start` handler issues a fresh portal token and queues another
onboarding email on every run, so freeing its key re-armed a duplicate email and
a second live magic link.

The earlier round's architecture note claimed every key in use was time-scoped
and therefore safe to free. That was simply wrong — `onboarding.start:<id>`,
`payment.draft:<id>`, `project.offboarding_tasks:<id>` and others carry no time
component — and the note has been corrected rather than quietly dropped.

**Repaired.** `Job.dedupeScope` is an explicit column, never inferred from the
shape of the key:

| Scope | Meaning | Pruned? |
| --- | --- | --- |
| `DISPOSABLE` | Provably cannot recur: a tick bucket, or a one-shot keyed by the millisecond it was queued | Yes, with its history |
| `DURABLE` (default) | Identifies a business event | Never |

Pruning now touches only rows with no key at all or an explicitly disposable
one. The default is `DURABLE` because a freed key fails silently; a caller who
says nothing gets retention. The migration backfills the four existing key
shapes that carry a timestamp, so accumulated scheduler history stays prunable
without deleting anything.

Growth is one retained row per business event — business volume, not tick
frequency — and the Worker screen now shows the split between prunable history,
rows kept for deduplication, and failures.

**Tests** (`dedupe-retention.test.ts`, real PostgreSQL):

| Test | Demonstrates |
| --- | --- |
| Disposable history | Scheduler ticks and keyless jobs are pruned |
| Failures | FAILED and DEAD survive any age, with their error text |
| An aged business event | Not pruned; a replay is still deduplicated |
| An unmarked key | Defaults to DURABLE and is retained |
| A real replay after a real sweep | An accepted invitation drives `onboarding.start`; after the maintenance sweep runs and the event is re-enqueued, the outbox count and the portal-token count do not move |
| Retention reporting | The three counts the Worker screen displays |

---

### 8. Concurrent dispatch reported work it had not done

**Reproduced.** Two overlapping dispatch requests on one batch of three, on
separate connections:

```
request A reported dispatched: 3
request B reported dispatched: 3
reported total:                6
invitations actually created:  3
```

Three distinct faults. A recipient transaction that returned early because
another request had already settled the row still fell through to
`dispatched += 1`. Failure recording updated the recipient unconditionally,
outside the transaction that had just rolled back, so a slow failure could
overwrite a recipient another request had since marked SENT — leaving somebody
who *was* invited reading FAILED. And the batch's final status came from the
request's own tally rather than from the rows.

**Repaired.**

- The per-recipient transaction returns an outcome (`sent`, `skipped`, `failed`,
  `taken`), and only `sent` is counted. Work another request committed is
  reported separately as `takenByAnotherRequest`.
- `recordDispatchFailure` is a compare-and-set on `dispatchState IN (PENDING,
  FAILED)`. A stale verdict against a settled recipient matches no row, changes
  nothing, and reports `taken`. It is exported so the guard can be tested
  directly rather than only through a race.
- Final status and the totals returned come from `recipientTotals`, a `groupBy`
  over the recipient rows, so both overlapping requests report the same
  authoritative picture. The status update tolerates another request having
  already reached the same state.

After the repair, the same race reports 3 committed and 3 taken, against 3
invitations.

**Tests** (`outreach-concurrency.test.ts`, separate real connections):

| Test | Demonstrates |
| --- | --- |
| Two overlapping requests | Reported committed work sums to the invitations created; each request accounts for every recipient as either done or taken; both report identical totals |
| One request failing while the other succeeds | No recipient holding an invitation reads anything but SENT; no infrastructure fault became a permanent exclusion; a later dispatch finishes the batch |
| The guard alone | A stale infrastructure failure *and* a stale eligibility refusal against a SENT recipient both change nothing, not even the attempt count |
| Refusal versus fault | An infrastructure fault leaves FAILED and retryable; a domain refusal on that same row leaves SKIPPED with its reason and clears the error |
| Status from the rows | A recipient settled out of band still counts towards completion; the batch reaches DISPATCHED with `dispatchedAt` stamped |
| Repeating on a finished batch | Three concurrent repeats each report zero committed, and the invitation and audit counts do not move |

---

### 9. Development and production build output collided

**Reproduced.** `npm run build` wrote to `.next`, the directory a running
`next dev` serves from. During the previous round this left `/apply/enter`
returning 500 until the dev server reloaded — the failure was observed twice,
not theorised.

**Repaired.** Three directories, one per mode, set explicitly by the scripts so
the choice never depends on how `NODE_ENV` resolves:

| Mode | Directory |
| --- | --- |
| `npm run dev` | `.next-dev` |
| `npm run build`, `npm start` | `.next-prod` |
| `npm run e2e` | `.next-e2e` |

`next.config.ts` keeps a fallback that still separates development from
production for a bare `npx next …`. All three are gitignored, excluded from
lint, Prettier and `tsc`.

**Verified.** With the development server serving on port 3000, a full
production build ran to completion and the dev server answered `/dashboard`,
`/jobs`, `/outreach` and `/apply/enter` with 200 immediately afterwards. A
production server started from `.next-prod` served the build id recorded in
`.next-prod/BUILD_ID`, which does not appear in anything the dev server serves.
Database contents were untouched throughout; the temporary production server was
pointed at the browser-test database and stopped afterwards.

---

### 10. Worker guarantees stated too broadly

No defect, and the worker was not redesigned: no regression demonstrated one.
The wording was too broad. "At-most-once committed effect" invited the reading
that fencing prevents duplicate external calls.

It now reads **at-least-once execution, at-most-once committed *database*
effect per claim**, with the limit stated plainly: fencing cannot undo anything
that has already left the process, and a rollback after a real email or payment
call would remove the record while leaving the side effect standing. Adding such
a handler requires an idempotency mechanism the remote side honours. Corrected
in `docs/architecture.md`, `docs/limitations.md` and above.

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

### From the second round

- **Durable job rows accumulate.** One row per business event, kept forever so
  its deduplication key survives. That is business volume rather than tick
  frequency, and the Worker screen shows the count, but nothing archives them.
- **Scope is a caller's judgement.** `DISPOSABLE` is honoured, not verified. A
  caller that marks a genuinely reusable key disposable would reintroduce the
  defect; the default protects only the caller who says nothing.
- **The concurrency tests assert invariants, not interleavings.** Two
  overlapping requests are genuinely raced on separate connections, and the
  assertions hold for every ordering, but a specific ordering is not forced. The
  compare-and-set guard is additionally tested directly, which is the part a
  race might not reach.
- **The running development server predates the directory change.** It was
  started before `.next-dev` existed and still serves from `.next`; the next
  `npm run dev` picks up the new directory. `.next` can be deleted once nothing
  is serving from it.
- **Worker guarantees are database-only.** Stated above, repeated here because
  it is the easiest thing to over-read: nothing in the fencing design makes an
  external call idempotent.

---

## Worker guarantees, stated narrowly

**At-least-once execution. At-most-once committed database effect per claim.**

A handler may run twice; only one run can commit. That works because the effect
and the proof of the effect are the same transaction in the same database, and
every effect in this build is a row: simulated outbox messages, invitations,
activity entries, attention items, payment items. Nothing leaves the process.

Transactional fencing does **not** make an external call idempotent. A real
email, a payment authorisation or any other outbound request happens the moment
it is made; rolling back afterwards deletes the record of it and leaves the side
effect standing, which is worse than not rolling back. Adding such a handler
means adding idempotency the remote side honours — an idempotency key, a
provider-side deduplication window, or an outbox row marked sent only after a
confirmed response. None of that exists here, because no such handler exists
here.
