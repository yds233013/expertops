# ExpertOps

A local-only operator workspace for running an expert network: sourcing expert
records, matching them to client projects, inviting them, onboarding them,
verifying them, and staffing them onto project seats.

This repository contains the **first complete product slice**, built end to end:

```
project creation → matching → invitation → expert acceptance →
availability → onboarding → operator verification → staffing assignment
```

Everything runs against local services with synthetic data. There are no paid
APIs, no language models, no real email, no external accounts and no public
deployment anywhere in this build.

---

## Contents

- [Setup](#setup)
- [Running the application](#running-the-application)
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
Test Files  15 passed (15)
     Tests  243 passed (243)
  Duration  ~42s
```

| Suite | Tests | Covers |
| --- | --- | --- |
| `tests/unit/matching-engine.test.ts` | 21 | Scoring, determinism, hard exclusions, ranking |
| `tests/unit/lib.test.ts` | 22 | Errors, references, money, time, timezone overlap, retry backoff |
| `tests/unit/state-machines.test.ts` | 15 | Every legal and illegal transition |
| `tests/unit/email-templates.test.ts` | 8 | Rendering, and the "not delivered" disclosure |
| `tests/unit/onboarding-checklist.test.ts` | 6 | Checklist shape, absence of protected attributes |
| `tests/unit/permissions.test.ts` | 6 | Role capability matrix |
| `tests/api/auth.test.ts` | 10 | Login, sessions, logout, health |
| `tests/api/operator-workflow.test.ts` | 25 | Expert, project, matching, invitation, staffing, jobs endpoints |
| `tests/api/portal.test.ts` | 16 | Portal session, invitations, availability, onboarding |
| `tests/integration/workflow.test.ts` | 3 | The full slice end to end, plus decline and rework paths |
| `tests/integration/failure-cases.test.ts` | 52 | Every documented failure case |
| `tests/integration/concurrency.test.ts` | 16 | Races over seats, invitations, verification, jobs, schedules |
| `tests/integration/worker.test.ts` | 23 | Scheduling, execution, retries, dead-lettering, the run loop |
| `tests/integration/activity-and-outbox.test.ts` | 9 | Attribution, paging, rollback, simulated delivery |
| `tests/integration/seed.test.ts` | 11 | Repeatability and seed-data invariants |

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

- **Verifying or returning an onboarding submission.** An expert cannot become
  staffable any other way. Returning one requires a written reason.
- **Confirming a staffing assignment.** This is what consumes a seat.
- **Releasing a seat.** Requires a reason.
- **Withdrawing an invitation.** Requires a reason.
- **Changing a project's status by hand,** and creating experts, projects and
  invitations.

### Simulated email delivery

There is no SMTP client, no email API, and no network call in the mail path.
`queueMessage` writes a row; the worker's `outbox.dispatch` job flips it to
`SENT`. "Sent" means exactly that and nothing more.

Every rendered body ends with:

> This message was generated by a simulated outbox and was not delivered to any
> mail server.

### Not implemented (future integrations)

Present as named job types that deliberately do nothing, so the shape of the
integration is visible without pretending it exists:

- `assignment.notify` — pushing a confirmed assignment to an external scheduling
  or resourcing system.
- `onboarding.notify_decision` — notifying a client-side system of a
  verification decision.

Both return `{ notified: false, reason: 'not implemented in this slice' }`. The
expert-facing emails for those events are queued synchronously by their
services, so nothing is silently dropped.

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Layering, the service boundary, the job queue, concurrency strategy |
| [`docs/workflow-states.md`](docs/workflow-states.md) | Every state machine, transition, and guard |
| [`docs/limitations.md`](docs/limitations.md) | What this build does not do, and what would have to change |

---

## Known limitations

The short version. [`docs/limitations.md`](docs/limitations.md) has the full
list with reasoning.

**This is a first product slice, not a production system, and no claim is made
about its readiness for one. No time saving has been measured, and none is
claimed.**

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
- **Deliberately out of scope for this slice:** recruitment scraping, payroll,
  chatbots, and evaluation infrastructure.

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
