# ExpertOps

A local-only operator workspace for running an expert network end to end:
finding people, qualifying them, onboarding them, staffing them onto client
projects, supporting them through delivery, and preparing payment.

The whole lifecycle, in one connected system:

```
application → screening → human qualification → onboarding → operator
verification → invitation → acceptance → availability → staffing assignment →
work submission → human review → payment preparation → export → offboarding
```

Routine coordination is automated. Consequential decisions are not: ten named
approval gates require a signed-in human, and every one is recorded against the
operator who made it.

Everything runs against local services with synthetic data. There are no paid
APIs, no language models, no real email, no external accounts and no public
deployment anywhere in this build.

ExpertOps is an independent project inspired by the responsibilities of an
operations role at a frontier AI data lab. It is not affiliated with any
company, and it makes no comparison to any commercial product.

---

## Contents

- [Setup](#setup)
- [Running the application](#running-the-application)
- [The cybersecurity demo](#the-cybersecurity-demo)
- [Demo walkthrough](#demo-walkthrough)
- [Demo credentials](#demo-credentials)
- [Testing](#testing)
- [What is automated, what a human decides, what is simulated](#what-is-automated-what-a-human-decides-what-is-simulated)
- [Documentation](#documentation)
- [Known limitations](#known-limitations)

---

## Setup

### Requirements

| Tool | Version used | Notes |
| --- | --- | --- |
| Node.js | 20.11 or newer (built on 24.1) | |
| Docker | any recent release | Only used to run PostgreSQL |
| PostgreSQL | 16 | Supplied by docker compose |

### First run

```bash
git clone <this repository>
cd expertops

npm install
cp .env.example .env          # every default points at a local service

npm run db:up                 # starts PostgreSQL on host port 5433
npm run db:migrate            # applies prisma/migrations
npm run db:generate           # generates the Prisma client
npm run db:seed               # loads repeatable synthetic data
```

`npm run db:up` publishes PostgreSQL on **5433**, not 5432, so it does not
collide with a PostgreSQL you may already run locally. It also creates a second
database, `expertops_test`, used only by the test suite.

To point at your own PostgreSQL instead, set `DATABASE_URL` and
`TEST_DATABASE_URL` in `.env` and skip `npm run db:up`.

---

## Running the application

The application is two processes. Run them in separate terminals.

```bash
# terminal 1 — web application on http://localhost:3000
npm run dev

# terminal 2 — background worker (job queue + scheduler)
npm run worker
```

Then open <http://localhost:3000> and sign in with one of the
[demo credentials](#demo-credentials).

**The worker is not optional.** Invitations are queued by the UI and sent by the
worker, so without it invitations stay in `DRAFT` and the simulated outbox never
drains. The Worker screen in the app shows queue depth and schedule state.

### Every command

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js development server on port 3000 |
| `npm run build` / `npm start` | Production build and server |
| `npm run worker` | Worker with file watching |
| `npm run worker:start` | Worker without watching |
| `npm run worker:once` | One worker tick, then exit |
| `npm run db:up` / `npm run db:down` | Start / stop the PostgreSQL container |
| `npm run db:migrate` | Apply migrations (`prisma migrate deploy`) |
| `npm run db:migrate:dev` | Create a new migration from a schema change |
| `npm run db:generate` | Regenerate the Prisma client |
| `npm run db:seed` | Load synthetic seed data (truncates first) |
| `npm run db:studio` | Prisma Studio |
| `npm test` | Full test suite |
| `npm run test:unit` / `test:api` / `test:integration` | One layer |
| `npm run smoke` | Scripted walkthrough against a running app |
| `npm run demo` | Repeatable cybersecurity demo, additive and run-tagged |
| `npm run demo:clean` | The same, removing previous demo runs first |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format` / `format:check` | Prettier |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify` | format check + lint + typecheck + tests |

### Database setup and seed, in one block

```bash
npm run db:up        # PostgreSQL 16 in Docker on port 5433
npm run db:migrate   # apply prisma/migrations
npm run db:generate  # regenerate the Prisma client
npm run db:seed      # 3 operators, 20 skills, 36 experts, 5 projects, 5 schedules
```

`npm run db:seed` truncates every table before inserting, and generates from a
fixed pseudo-random seed, so running it twice produces byte-identical data. A
test asserts this.

---

## The cybersecurity demo

One command builds a complete, realistic slice and walks it through every
exception an operator is meant to handle.

```bash
npm run demo          # additive: safe against a populated database
npm run demo:clean    # remove previous demo runs first
```

It is **isolated**: every record carries a run tag and the script never
truncates anything, so it can run against your development database without
touching what is already there.

It is **repeatable**: time is driven by an injected clock that the script
advances explicitly, so deadlines and overdue reminders happen deterministically
without sleeping. There is no HTTP endpoint anywhere that can change the time,
and the clock refuses to install in a production build.

What the run demonstrates, in order:

| Step | What you see |
| --- | --- |
| 1 | A rubric is published. It can never be edited again. |
| 2 | A project needs four cybersecurity experts. |
| 3 | Two existing experts qualify; one is qualified but has zero capacity; a sourcing campaign opens for the shortfall. |
| 4 | A candidate applies and submits an **incomplete** screening, recorded as incomplete rather than bounced. |
| 5 | The reviewer goes **overdue**; the clock jumps 36 hours and an attention item appears. |
| 6 | Two reviewers **disagree**; the system refuses to break the tie and an admin resolves it. |
| 7 | An accepted expert is **blocked by a support request** even after verification. |
| 8 | An assigned expert **withdraws**; a replacement batch is proposed but sends nothing. |
| 9 | An admin **approves** the batch. Only then is anything dispatched. |
| 10 | Work is submitted, **needs a revision**, is resubmitted and approved at fewer hours than claimed. |
| 11 | The resulting **payment discrepancy** is explained, the batch is approved by a second operator, and the CSV is printed. |

The run finishes by printing the attention queue, so you can see exactly what an
operator would be left holding.

---

## Demo walkthrough

This is the full product slice. It takes about five minutes. Both `npm run dev`
and `npm run worker` must be running.

### 1. Sign in as an operator

Go to <http://localhost:3000/login> and sign in as
`operator@expertops.test`. The dashboard shows pipeline counts, the registered
scheduled jobs, and recent activity.

### 2. Create a project

**Projects → New project.**

- Title: *Card settlement reconciliation review*
- Client: *Northwind Logistics*
- Seats: `1`, minimum experience: `5`, rate ceiling: `400`
- Add a requirement: *Payments Infrastructure*, **Required**, min `3/5`, weight `5`
- Add a second: *Risk Modelling*, **Optional**, min `2/5`, weight `2`

The project is created in `DRAFT`.

### 3. Open it for matching, then run the scorer

On the project page, click **Open for matching**, then **Run matching**.

The ranking appears with a score out of 100 and the per-component contribution
behind each score (skills, seniority, rate, availability, standing). Experts who
failed a hard filter are collapsed under *"N expert(s) excluded by a hard
filter"* with the reason for each. The scoring is deterministic rules, versioned
as `rules-v1`. No language model is involved.

### 4. Invite the top candidate

Click **Invite** next to the top-ranked expert, add a note, pick a response
window, and send. The invitation is created in `DRAFT` and a job is queued.

Within a second or two the worker renders the email and marks the invitation
`SENT`. Watch it happen on the **Worker** screen.

### 5. Read the simulated email and open the expert portal

Go to **Outbox**. The invitation is there with its full body. Nothing was sent
anywhere: the message footer says so, and the page is labelled *Simulated
email*.

In development the message also shows a **portal link**. Open it. That is how an
expert reaches their portal: a single-use magic link, no password. Opening the
same link a second time is refused.

### 6. Accept as the expert

In the portal, read the brief and click **Accept**.

Three things happen: the invitation becomes `ACCEPTED`, the expert moves to
`ONBOARDING`, and their onboarding checklist opens.

### 7. Declare availability

Still in the portal, add an availability window: a start date, an end date,
hours per week, and optionally the project you just accepted. Staffing will not
allow an allocation larger than what is declared here.

### 8. Complete and submit the onboarding checklist

Tick the attestations, write *None* for conflicts, and put any string in the
billing reference (it is simulated; no payment details are collected). Click
**Submit for review**.

The expert moves to `PENDING_VERIFICATION`. Note the wording: *waiting on a
human operator*. Nothing is approved automatically.

### 9. Try to staff them too early

Back in the operator workspace, open the project and look at **Staffing**. The
expert appears with the blocking reason *"Waiting on operator verification"*.
Attempting to staff them through the API is refused with a clear message.

### 10. Verify as the operator

Go to **Verification** (the badge shows how many are waiting). Review the
checklist and the profile, then click **Verify expert**. Returning a submission
instead requires a reason.

The expert becomes `VERIFIED`. A verification email is queued to the simulated
outbox.

### 11. Staff the seat

Back on the project, the expert is now staffable. Set hours per week and a rate,
click **Propose**, then **Confirm seat**.

Confirming is the step that consumes a seat. The project fills, moves to
`ACTIVE`, and a confirmation email is queued.

### 12. Read the history

The **Project history** panel at the bottom lists every transition, each
attributed to the operator, the expert, or the worker that caused it. The
**Activity** screen shows the same across the whole workspace, filterable by
actor.

### Running the walkthrough as a script

```bash
npm run smoke
```

`scripts/smoke.ts` drives the real HTTP API exactly as the browser does,
cookies included, through the whole slice plus the documented failure cases. It
creates its own expert and project so it is safe to run repeatedly.

---

## Demo credentials

Created by `npm run db:seed`. **Development only.**

| Role | Email | Can do |
| --- | --- | --- |
| `ADMIN` | `admin@expertops.test` | Everything, plus retrying worker jobs and managing operators |
| `OPERATOR` | `operator@expertops.test` | Projects, matching, invitations, verification, staffing |
| `VIEWER` | `viewer@expertops.test` | Read only |

All three use the password in `SEED_DEMO_PASSWORD` in your `.env`, which
defaults to `demo-password-123`.

### Development-only restrictions on these credentials

- **They exist only in the local seed.** Nothing creates them outside
  `prisma/seed.ts`, and the seed truncates every table before it runs, so it is
  not something you would point at real data.
- **The password is shared across all three accounts** and is printed to your
  terminal by the seed. It is a convenience for a local demo and nothing else.
- **The login page lists the three email addresses** when `NODE_ENV` is not
  `production`. That hint disappears in a production build.
- **`@expertops.test` and `@example.test` are reserved test domains.** They
  cannot receive mail, which is the point: no seeded address can be contacted
  even by accident.
- **Experts never get a password at all.** They sign in through a single-use
  magic link. With `EXPOSE_PORTAL_LINKS_IN_UI=true` those links are shown in the
  operator outbox so the workflow is demoable without email; that flag is forced
  off when `NODE_ENV=production`.

Before this were ever deployed anywhere, the seed accounts would need removing
and `AUTH_SECRET` would need replacing. See
[Known limitations](#known-limitations).

---

## Testing

```bash
npm test                  # everything
npm run test:unit         # pure logic, no database
npm run test:api          # route handlers, real database
npm run test:integration  # services, worker, concurrency, seed
```

Integration and API tests run against the real `expertops_test` PostgreSQL
database. They apply migrations once per process and truncate between cases, so
`npm run db:up` must be running.

### Results

```
Test Files  23 passed (23)
     Tests  417 passed (417)
  Duration  ~132s
```

| Suite | Tests | Covers |
| --- | --- | --- |
| `tests/unit/matching-engine.test.ts` | 21 | Scoring, determinism, hard exclusions, ranking |
| `tests/unit/decimal-and-csv.test.ts` | 34 | Exact money arithmetic, CSV injection, reminder policy |
| `tests/unit/lib.test.ts` | 22 | Errors, references, money, time, timezone, backoff |
| `tests/unit/state-machines.test.ts` | 15 | Every legal and illegal transition |
| `tests/unit/email-templates.test.ts` | 8 | Rendering, and the "not delivered" disclosure |
| `tests/unit/onboarding-checklist.test.ts` | 6 | Checklist shape, absence of protected attributes |
| `tests/unit/permissions.test.ts` | 6 | Role capability matrix |
| `tests/api/auth.test.ts` | 10 | Login, sessions, logout, health |
| `tests/api/csrf.test.ts` | 18 | Cross-origin rejection on both session kinds |
| `tests/api/operator-workflow.test.ts` | 25 | Expert, project, matching, invitation, staffing, jobs |
| `tests/api/portal.test.ts` | 16 | Portal session, invitations, availability, onboarding |
| `tests/api/extension-access.test.ts` | 19 | Capability boundaries on every new endpoint |
| `tests/integration/lifecycle.test.ts` | 3 | Application to payment export; reminder suppression |
| `tests/integration/screening.test.ts` | 32 | Rubric immutability, reviews, conflicts, duplicates |
| `tests/integration/delivery-and-payment.test.ts` | 25 | Work, support, payment, offboarding |
| `tests/integration/withdrawal-and-attention.test.ts` | 26 | Gaps, withdrawal, replacement, the attention queue |
| `tests/integration/expert-import.test.ts` | 16 | CSV preview, commit, export, injection |
| `tests/integration/workflow.test.ts` | 3 | The original staffing slice end to end |
| `tests/integration/failure-cases.test.ts` | 52 | Every documented failure case |
| `tests/integration/concurrency.test.ts` | 16 | Races over seats, invitations, verification, jobs |
| `tests/integration/worker.test.ts` | 24 | Scheduling, execution, retries, dead-lettering |
| `tests/integration/activity-and-outbox.test.ts` | 9 | Attribution, paging, rollback, simulated delivery |
| `tests/integration/seed.test.ts` | 11 | Repeatability and seed-data invariants |

### Test database safety

The suite truncates every table between cases, so `assertTestDatabase()` refuses
to run unless the connection string names a database containing `test`. Pointing
the suite at your development database fails loudly rather than destroying it.

### Concurrency tests

These use multiple Prisma clients on separate connections, so the races are
genuine at the database level:

- Two simultaneous confirmations for the last seat: exactly one wins, the other
  gets `CAPACITY_EXCEEDED`.
- Eight confirmations racing for three seats: exactly three succeed, the
  project is never oversubscribed, and exactly three confirmation emails exist.
- Two operators confirming the same assignment: one succeeds.
- An expert double-clicking accept, and a simultaneous accept + decline.
- Two operators inviting the same expert at the same moment.
- Two operators deciding the same verification case.
- A portal magic link clicked twice at once.
- Four workers claiming from one queue: no job is ever handed out twice.
- Three workers draining thirty jobs: each is claimed exactly once.
- Three workers ticking the scheduler at the same instant: each schedule fires
  once.
- Three dispatchers draining the outbox: each message is delivered once.
- A job whose worker died mid-run is reclaimed after the lock times out.
- Two operators resolving the same duplicate flag: one wins.
- Two operators deciding the same outreach batch: one wins.
- Two workers drafting a payment from the same approved review: one item exists.
- Two operators confirming the same offboarding task: one wins.
- Three workers sweeping the attention queue at once: one item, not three.

---

## What is automated, what a human decides, what is simulated

The UI labels every one of these, and this is what the labels mean.

### Automated (no human in the loop)

Performed by the background worker:

- Rendering and "sending" invitation emails
- Closing invitations past their response deadline
- One reminder per open invitation
- Opening an onboarding checklist after acceptance, and nudging stalled ones
- Marking queued outbox messages as delivered
- Purging expired sessions and old finished jobs
- Advancing a project's status when a workflow step implies it

Also automated, but triggered by an operator: candidate scoring. It is
deterministic rules, versioned `rules-v1`, and every score is broken down into
its components in the UI.

### Human operator confirmations

These never happen on their own. Each requires a signed-in operator with the
right capability, and each is recorded in the activity history with that
operator's identity:

- **Qualifying or rejecting a screened candidate.** Needs at least one submitted
  human review, and any reviewer disagreement resolved first.
- **Resolving conflicting reviewer decisions.** Admin-only. The system never
  breaks a tie.
- **Deciding whether two records are the same person.** Nothing merges
  automatically.
- **Verifying or returning an onboarding submission.** An expert cannot become
  staffable any other way. Returning one requires a written reason.
- **Approving a batch of invitations or replacement outreach.** Admin-only, and
  a batch over five recipients cannot be self-approved.
- **Confirming a staffing assignment.** This is what consumes a seat.
- **Approving submitted work** and setting the authorised quantity.
- **Clearing a payment discrepancy,** with a written explanation.
- **Approving a payment batch.** Admin-only, and never by whoever created it.
- **Confirming an offboarding task,** with a note, because the system cannot
  verify it.
- **Releasing a seat** and **withdrawing an invitation,** both requiring a
  reason.

Full detail, including the capability each needs, is in
[`docs/automation.md`](docs/automation.md).

### Simulated email delivery

There is no SMTP client, no email API, and no network call in the mail path.
`queueMessage` writes a row; the worker's `outbox.dispatch` job flips it to
`SENT`. "Sent" means exactly that and nothing more.

Every rendered body ends with:

> This message was generated by a simulated outbox and was not delivered to any
> mail server.

### Not implemented (future integrations)

The original build shipped two job types that reported success while doing
nothing. **Both have been removed.** A job that always succeeds without acting
makes the Worker screen look healthier than the system is, and nothing enqueued
them anyway.

What they gestured at — pushing a confirmed assignment or a verification
decision to an external system — does not exist and is not pretended to. There
is no adapter, no credentials and no retry story for it. Adding one is listed in
[`docs/requirement-coverage.md`](docs/requirement-coverage.md) under *Not done*.

Other unfinished areas, stated in the same place: the candidate-facing portal
pages, the rubric authoring screen, and the sourcing campaign detail screen. All
three have working service and API layers; only the UI is missing.

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Layering, the service boundary, the job queue, concurrency strategy |
| [`docs/automation.md`](docs/automation.md) | Every event-driven workflow, approval gate and reminder rule |
| [`docs/playbook.md`](docs/playbook.md) | A short operator playbook: how to actually run a day |
| [`docs/workflow-states.md`](docs/workflow-states.md) | Every state machine, transition, and guard |
| [`docs/requirement-coverage.md`](docs/requirement-coverage.md) | What was asked for, where it lives, and what is unfinished |
| [`docs/limitations.md`](docs/limitations.md) | What this build does not do, and what would have to change |

---

## Known limitations

The short version. [`docs/limitations.md`](docs/limitations.md) has the full
list with reasoning.

**This is a working demonstration, not a production system, and no claim is made
about its readiness for one. No time saving has been measured and none is
claimed. No comparison is made to any commercial product.**

- **Security is sized for a local demo.** Cookie sessions with no CSRF tokens,
  no rate limiting, no account lockout, no audit of reads. bcrypt cost 10.
- **Matching is deliberately simple.** Six weighted components over declared
  skills. It has no notion of past performance, client feedback, or relevance
  beyond a skill tag, because none of that data exists yet.
- **Search does not scale.** Expert and outbox search are `ILIKE` scans with no
  full-text index.
- **The worker has no observability beyond the job table.** No metrics, no
  tracing, no alerting. A dead job is visible only to someone looking at the
  Worker screen.
- **Only one clock.** Availability windows, project dates and the scheduler all
  work in UTC. Timezone is used for overlap scoring, not for rendering.
- **No client-facing side.** Clients exist as a name on a project. There is no
  client login, no approval step, and no deliverable tracking.
- **No money movement.** Rates are recorded; nothing is invoiced or paid. The
  billing reference on the onboarding checklist is a simulated string.
- **The UI is not fully accessible.** Keyboard navigation and screen-reader
  labelling have not been audited.
- **Payment preparation is not payment.** The system prepares and exports a
  file. It has no connection to any financial system, performs no transaction,
  and has no way to know whether anyone was actually paid.
- **Offboarding is a record of statements,** not of verified actions. ExpertOps
  does not touch external accounts.
- **Duplicate detection is deliberately crude:** exact email, or exact name. It
  is a prompt for a human, not a resolution engine.
- **Parts of the UI are unfinished.** The candidate portal pages, the rubric
  authoring screen and the campaign detail screen do not exist; those flows are
  API-only today. See
  [`docs/requirement-coverage.md`](docs/requirement-coverage.md).
- **Deliberately out of scope:** recruitment scraping, payroll, chatbots, and
  evaluation infrastructure.

### On protected personal attributes

No protected personal attribute is collected, stored, inferred, or used in
scoring. Expert records hold professional and operational data only: skills and
proficiency, years of experience, hourly rate, working timezone, weekly
capacity, and a headline. There is no field for age, date of birth, gender, sex,
race, ethnicity, nationality, citizenship, religion, disability, health, marital
or family status, sexual orientation, political affiliation, or union
membership — and the onboarding checklist asks for none of them.

Timezone is the only attribute that could be misread as a proxy. It is used in
exactly one place, to compute working-hours overlap for scheduling, and is
scored on overlap alone, never on which region it names.

Two tests guard this: one asserts the onboarding checklist mentions no
protected term, another asserts no expert column is named after one.
