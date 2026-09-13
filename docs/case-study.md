# ExpertOps — project case study

An independent personal project. Not affiliated with, endorsed by, or derived
from any employer or commercial product. Email is simulated, there is no payment
execution, and nothing here is a production service.

---

## The problem

An expert network runs a pipeline that is mostly decisions: is this person good
enough, who should we approach, who takes the seat, was the work acceptable, what
do we owe them. The decisions are cheap individually and expensive in aggregate,
because each one has to be findable afterwards — by a colleague, an auditor, or
the person it was about.

Most of the failure modes are not algorithmic. They are: two people quietly doing
the same thing, a seat oversubscribed under a race, an expert dropping out and
nobody noticing for a week, an approval nobody can attribute, a message that
looks sent but was not.

ExpertOps is an operations layer built around one rule: **the system assembles,
a person decides.** Automation prepares, ranks, detects and queues. Anything that
contacts a human, commits a seat, or touches money stops and waits for an
operator, and the record says which of them did it.

## Architecture

Next.js 15 App Router with React 19 and TypeScript, PostgreSQL 16+ through
Prisma, Tailwind. One repository, one deployable image, three runtime roles from
that image: the web app, a background worker, and a one-shot migration step.

Layering is strict and one-directional: pure domain logic, then services, then an
HTTP adapter, then routes and server components. Services take a `Db`,
`Transactor` or `MaybeTransactor` rather than importing a client, so any service
composes inside a caller's transaction.

The job queue is PostgreSQL, not Redis. Workers claim rows with `FOR UPDATE SKIP
LOCKED` under a per-claim fencing id and a bounded lease with heartbeats, so
several can run at once, a killed worker's claims are reaped, and a paused
process that wakes up late finds its work gone and rolls back rather than
double-applying it. One fewer moving part to operate, and the queue is
transactional with the business data it acts on.

## Engineering decisions worth defending

**Approval is a state machine, not a button.** An outreach batch goes `DRAFT →
PENDING_APPROVAL → APPROVED → DISPATCHED`, and dispatch is separate from
approval. A payment batch adds a constraint the UI cannot express: the approver
must not be the creator, enforced server-side.

**Withdrawal is one transaction.** An expert leaving touches the assignment, the
seat count, the project status, the invitation, outstanding work, several
attention items, and a queued replacement search. Doing that in pieces produces a
project that is half-reopened. It is one `withTransaction` with a row lock on the
project and a short-circuit if the withdrawal already happened.

**Portal tokens live in the URL fragment.** Browsers do not send fragments to
servers, so the landing request's path, the access log, and any `Referer` derived
from that page contain `/portal/enter` and nothing else. An earlier design put
the token in the path, where the first GET wrote it into the request log
permanently.

**Destructive operations are fail-closed.** Seeding and truncation consult an
allow list of exactly three database names. Anything unrecognised is refused
rather than assumed safe, because a deny list has to anticipate every production
name while an allow list only has to know the ones this repository owns.

**The production config guard distinguishes deployment from build.** `next start`
forces `NODE_ENV=production` even for a local browser-test build, so a separate
`EXPERTOPS_ENV` decides whether the deployment safety checks apply. The guard
refuses to boot on a demo secret, an exposed-portal-links flag, plain HTTP, or a
`DATABASE_URL` pointing at a development database.

**Simulated delivery is stated as a fact, not implied.** `deliveryMode()` is one
named value the UI reads, so "sent" never reads as "emailed" anywhere on screen.

## Verified results

Full detail, including method and what each run could not establish, is in
[`staging-verification.md`](staging-verification.md).

- **603 tests** across 41 files: unit, API, and integration against real
  PostgreSQL. Concurrency is covered directly — the last seat under two
  simultaneous confirmations, many confirmations racing for a few seats,
  double-clicked invitation responses, simultaneous accept and decline, one job
  never handed to two workers, a job reclaimed from a worker that died mid-run.
- **A browser journey suite** driving real pages as an operator, a candidate and
  an expert in separate contexts.
- **A hosted deployment on Railway**, behind an HTTP Basic gate, exercised by
  hand through the browser: a full lifecycle from invitation through onboarding,
  staffing, expert-initiated withdrawal, and an approved replacement.
- **Backup and restore** of business records, audit history and queued work into
  a fresh database, plus refusal of a corrupted dump, both covered by integration
  tests against real PostgreSQL.

Five defects were found by driving the deployed product rather than the test
suite, each fixed with a regression test that fails against the prior code: work
items that could never be reported overdue, a hosted deployment describing itself
as a local development build, an expert with no way back into their own portal,
a withdrawal leaving a project active while holding an empty seat, and a
re-invitation crashing dispatch on a unique constraint.

## Limitations

- **Email is simulated.** Rendered, stored, marked delivered by the worker. No
  transport exists.
- **No payment execution.** Payment preparation produces a CSV for a finance
  process elsewhere. Nothing moves money and no action marks anyone as paid.
- **The hosted database has no automatic backups.** Point-in-time recovery is
  disabled with no bucket configured; enabling it is a paid change that has not
  been made. Restore has been verified locally, not from a hosted backup.
- **Two-identity, not two-person.** The separation-of-duties control has been
  exercised with two accounts driven by one person. That shows the system binds
  approval to a second identity and records both. It shows nothing about whether
  a second human reviewed anything.
- **Single-operator provisioning.** There is no account-management screen;
  additional operators are created from a script with shell access.
- **Concurrent multi-tester behaviour on the hosted instance is unverified.**
  Race safety is evidenced locally against real PostgreSQL.
- **No measured time savings, no adopting organisation, and not production
  ready.** Nothing here has run against real participants or real money.
