# Known limitations

This is the first product slice of ExpertOps, built to run locally against
synthetic data. **No claim is made that it is production-ready, and no time
saving has been measured or is claimed anywhere in this repository.**

What follows is what the build does not do, and what would have to change.

---

## Scope

### Deliberately out of scope

The brief excluded these until the first slice is complete, and none of them are
present:

- Recruitment scraping or automated sourcing
- Payroll or payment processing
- Chatbots or conversational interfaces
- Model evaluation infrastructure

### Not built, though a real product would need it

- **A client-facing side.** A client is a name on a project. There is no client
  login, no approval of a proposed expert, no deliverable tracking, no
  reporting.
- **Contracts.** The onboarding checklist records attestations. It does not
  produce, store, or version a signed document.
- **Money.** Rates are recorded and displayed. Nothing is invoiced, approved, or
  paid. The billing reference on the checklist is a simulated string with no
  system behind it.
- **Time tracking.** An assignment records hours per week. Nothing records hours
  actually worked.
- **Expert-to-expert or expert-to-client messaging.** The only communication is
  one-directional simulated email.
- **Document handling.** No CV upload, no certificate storage, no file storage
  of any kind.
- **Bulk import.** Experts are created one at a time through the form or the
  API.

---

## Security

Sized for a local demo. Everything here would need work first.

- **No CSRF protection.** Sessions are cookie-based and state-changing endpoints
  accept a request with a valid cookie regardless of origin. `SameSite=Lax`
  mitigates the simplest cases and nothing more.
- **No rate limiting anywhere.** Login, the portal magic-link exchange, and
  every mutation are unthrottled. Login is brute-forceable.
- **No account lockout** after repeated failures.
- **bcrypt at cost 10** (cost 4 in tests, for speed). Defensible locally,
  low for anything else.
- **`AUTH_SECRET` has an insecure default** in `.env.example` and is only
  length-validated. Session and portal tokens are HMAC'd with it, so it must be
  replaced before the app is exposed to anyone.
- **No secret rotation.** Changing `AUTH_SECRET` invalidates every session and
  every unredeemed portal link at once.
- **Reads are not audited.** The activity history records writes. Nobody can
  tell who *looked* at an expert record.
- **No security headers** beyond Next.js defaults. No CSP, no HSTS.
- **Portal links are shown in the operator UI** when
  `EXPOSE_PORTAL_LINKS_IN_UI=true`. That is a deliberate demo affordance and it
  is forced off when `NODE_ENV=production`, but the flag exists and could be set
  by mistake.
- **The seed creates three known accounts with a shared, printed password.**
  They must be removed before deployment.
- **Session expiry is fixed** at `SESSION_TTL_HOURS`. There is no idle timeout
  distinct from absolute expiry, and no way for a user to see or revoke their
  other sessions.

---

## Matching

- **It only knows what was typed in.** Skills, proficiency, years, rate,
  timezone, capacity. It has no notion of past performance, client feedback,
  domain adjacency, or whether two skill names mean the same thing.
- **Proficiency is self-reported** and operator-adjustable, with nothing
  validating it.
- **Skills are exact-match on a slug.** "Postgres Performance" and "PostgreSQL
  Tuning" are unrelated to the scorer. There is no taxonomy, no synonyms, no
  hierarchy.
- **Weights are global defaults.** They can be overridden per run through the
  API, but the UI does not expose that, and there is no way to save a weighting
  per client or project type.
- **The decline cool-off is blunt.** Declining any invitation excludes an expert
  from *all* matching for 14 days. A real system would scope that to the client
  or the kind of work.
- **Availability scoring uses the profile-level weekly capacity**, not the
  specific windows an expert declared, so a match run does not know whether
  someone is free during the project's actual dates.
- **`loadCandidatePool` loads every non-archived expert into memory** and scores
  them in the application. Fine for thousands. Not fine for hundreds of
  thousands.
- **No feedback loop.** Nothing records whether a highly-ranked candidate
  actually worked out, so the weights cannot improve.

---

## Performance and scale

- **Expert and outbox search are `ILIKE '%term%'` scans.** No full-text index,
  no trigram index. They will degrade.
- **List pages fetch up to 100 rows with their relations** and render them all.
  Cursor pagination exists in the services and the API but the UI does not use
  it.
- **Every operator page is `force-dynamic`** and re-queries on each render. No
  caching layer.
- **`ActivityEvent` grows without bound.** The maintenance sweep prunes finished
  jobs; it deliberately does not prune history, which means it will need
  partitioning or archival eventually.
- **The seat-capacity row lock serialises confirmations per project.** That is
  the correct trade-off — correctness over throughput — but it is a per-project
  bottleneck.
- **No connection pooler.** Prisma's built-in pool only. Many worker processes
  would need PgBouncer.

---

## The worker

- **No observability beyond the `Job` table.** No metrics, no tracing, no
  alerting. A dead job is visible only to someone who opens the Worker screen.
- **No dead-letter handling beyond a manual retry button.** Nothing notifies
  anyone that a job died.
- **Intervals are code-owned.** `ensureDefaultSchedules` overwrites the interval
  and payload of every schedule on boot. An operator can disable a schedule but
  cannot retune one without a code change.
- **Schedule granularity is one second**, and the dedupe key buckets by second.
  Sub-second scheduling is not possible.
- **No job prioritisation beyond an integer** and no per-type concurrency limit.
  One slow job type can starve the batch.
- **The worker must be started separately.** Nothing supervises it, and the app
  does not warn on screen when it has not run recently — you have to read the
  Worker page.

---

## Email

**Every email in this system is simulated.** There is no SMTP client, no email
API, and no network call in the mail path. `queueMessage` writes a row and the
worker flips it to `SENT`. That is the entire delivery mechanism.

Consequences:

- **No delivery guarantees, bounces, or complaints.** `OutboxStatus.FAILED`
  exists in the schema and is never set.
- **Plain text only.** No HTML, no templating engine, no localisation.
- **No unsubscribe, no preference centre, no send-rate control.**
- **Nothing is idempotent against a real provider**, because there is no
  provider.

Making delivery real would mean an adapter behind `dispatchQueuedMessages`, a
provider with retries and a webhook for bounces, and a genuine suppression list.

---

## Time and dates

- **Everything is UTC.** Availability windows, project dates, and the scheduler
  all work in UTC, and the UI renders UTC with an explicit suffix.
- **Timezone is used for overlap scoring only,** not for rendering a time in the
  viewer's zone.
- **Availability windows are date ranges with a weekly hour count.** There is no
  day-of-week pattern, no recurring schedule, no holiday calendar.
- **Working-hours overlap assumes a 09:00–17:00 local day for everyone.**

---

## Data model

- **`Project.seatsFilled` is denormalised.** It is maintained under a row lock
  and recomputed rather than incremented, so it should not drift — but there is
  no reconciliation job that would catch it if it did.
- **Skills have no lifecycle.** Any operator can create one by typing a new
  name. There is no merge, rename, deprecate, or approval.
- **No soft deletes.** Experts are archived; projects are cancelled. Nothing
  else can be removed through the UI at all.
- **`MatchRun` rows accumulate forever**, each with a full candidate list.
- **One database, one schema.** No multi-tenancy, no row-level security.

---

## UI

- **Not audited for accessibility.** Keyboard navigation, focus management and
  screen-reader labelling have had no deliberate attention. Colour contrast has
  not been verified.
- **Light theme only.**
- **No optimistic updates.** Every mutation is a request followed by
  `router.refresh()`, so the whole page re-renders.
- **No live updates.** The Worker and Outbox screens need a manual reload to
  show what the worker just did.
- **Error display is per-component.** There is no global toast or error boundary.
- **Forms lose their contents** if a request fails after a navigation attempt.
- **No mobile layout work.** Tables scroll horizontally; that is the extent of
  it.
- **No undo** on any action.

---

## Testing

- **No browser-level end-to-end tests.** The UI was verified manually and the
  workflow is covered by `scripts/smoke.ts` driving the real HTTP API, but there
  is no Playwright or Cypress suite.
- **No component tests.** React components have no unit coverage.
- **No load or soak testing.** Concurrency is tested for correctness under a
  handful of simultaneous writers, not for behaviour under sustained load.
- **No coverage thresholds** are enforced.
- **Tests share one database and run serially,** so the suite takes about 40
  seconds and will grow linearly.
- **The seed test shells out to `npx tsx prisma/seed.ts`,** which makes it
  slower and more brittle than an in-process call.

---

## Operations

- **No deployment configuration.** No Dockerfile for the app, no CI pipeline, no
  health-check wiring beyond the `/api/health` endpoint itself.
- **No backup or restore procedure.** The Docker volume is the only copy.
- **No structured log shipping.** The logger writes lines to stdout.
- **No feature flags** beyond `EXPOSE_PORTAL_LINKS_IN_UI`.
- **No migration rollback strategy.** Prisma migrations are forward-only here.

---

## Protected personal attributes

No protected personal attribute is collected, stored, inferred, or used in
scoring anywhere in this build.

Expert records hold professional and operational data only: skills and
proficiency, years of experience, hourly rate, working timezone, weekly
capacity, a headline and a free-text background. There is no field — and no
checklist question — for age, date of birth, gender, sex, race, ethnicity,
nationality, citizenship, religion, disability, health, marital or family
status, pregnancy, sexual orientation, political affiliation, or union
membership.

**Timezone** is the one attribute that could be misread as a proxy for location
of origin. It is used in exactly one place — computing working-hours overlap for
scheduling — and contributes to the score only through that overlap number,
never through which region it names. It is stored because scheduling a call
requires it.

Two tests guard this, and both would fail on a regression:

- `tests/unit/onboarding-checklist.test.ts` asserts the checklist text contains
  no protected term, matched on word boundaries.
- `tests/integration/seed.test.ts` asserts no column on an expert row is named
  after one.

The free-text fields (`bio`, `notes`, `conflict_check`, `working_notes`) are not
validated for content. An operator or expert could type something protected into
one. Nothing in the scorer reads those fields, so it could not affect a ranking,
but a real deployment would want input guidance and a review process there.
