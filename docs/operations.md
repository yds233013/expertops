# Running ExpertOps

Startup, shutdown, backup, migration, rollback, and what to do when something
breaks. Written for the person on the other end of a problem at an awkward hour,
so every procedure is a command sequence with the reason stated once.

Nothing here has been exercised against a hosted deployment. Everything below
was run locally against PostgreSQL 16 in Docker, and the sections say which.

---

## The two processes

ExpertOps is a web server and a worker. Both are required.

```bash
npm run dev        # web, port 3000, builds into .next-dev
npm run worker     # worker: job queue and scheduler
```

**The worker is not optional and its absence is silent.** Invitations are queued
by the UI and sent by the worker; screening links, reminders, expiry sweeps and
payment drafting are all worker jobs. With no worker running, the application
looks healthy and simply stops doing anything. That is why the Worker screen
leads with "Is automation running?" rather than a job count, and why the
attention queue carries the same warning at the top.

### Production-shaped run

```bash
npm run build      # builds into .next-prod
npm start          # serves .next-prod, port 3000 (PORT to change)
npm run worker:start
```

Three build directories, one per mode — `.next-dev`, `.next-prod`, `.next-e2e` —
so a build never lands on top of a running server. That was a real failure: a
production build overwrote the development server's compiled routes and they
returned 500 until it reloaded.

### Starting in production mode refuses demo settings

`getEnv()` fails at boot when `NODE_ENV=production` and any of these is true:

| Refused | Why |
| --- | --- |
| `AUTH_SECRET` is the `.env.example` placeholder | It signs every session and portal token |
| `AUTH_SECRET` shorter than 32 characters | |
| `SEED_DEMO_PASSWORD` is `demo-password-123` | Seeded accounts share one known password |
| `EXPOSE_PORTAL_LINKS_IN_UI` is true | It prints single-use magic links in the UI |
| `APP_BASE_URL` is plain HTTP and not localhost | Sessions and portal links would travel unencrypted |

All problems are reported at once, not one per restart. None of these announces
itself at runtime — a demo secret signs real sessions perfectly well — so boot is
the only cheap place to catch them.

`next start` forces `NODE_ENV=production` for *any* production build, including
the one the browser suite runs locally against a throwaway database. The checks
care about the deployment rather than the build, so they key off `EXPERTOPS_ENV`,
which defaults to `NODE_ENV`. A real deployment sets nothing and gets the checks;
the browser suite sets `EXPERTOPS_ENV=test` and does not.

Setting `EXPERTOPS_ENV` to anything but `production` on a real deployment is an
operator switching off their own safety check.

---

## Shutdown

```
Ctrl-C            # both processes
```

The worker traps `SIGINT`/`SIGTERM`, stops claiming, and exits. A job that is
mid-flight is **not** waited for: its transaction rolls back and the claim is
recovered by the next worker once the lease expires. That is the intended
behaviour and it is tested — see *Interruption* below.

There is no drain mode. Stopping the worker during a large dispatch means those
recipients are retried, not lost.

---

## Backup

```bash
./scripts/backup.sh                       # writes backups/expertops-<stamp>.dump
./scripts/backup.sh backups/pre-migration # a named one before something risky
```

Custom-format `pg_dump`, plus a `.sha256` sidecar. The script uses the client
tools inside the `expertops-db` container when the ones on `PATH` are a
different major version, because `pg_dump` refuses to run against a newer
server and that refusal is not the operator's problem to solve at 2am.

`DATABASE_URL` already set in the environment wins over `.env`. That direction
matters: the opposite would silently back up development when you asked for
something else, which is exactly what an early version of this script did.

### Restore, and verifying a backup

```bash
./scripts/restore-check.sh backups/expertops-<stamp>.dump
./scripts/restore-check.sh backups/expertops-<stamp>.dump --keep
```

It verifies the checksum, creates a **uniquely named disposable database**,
restores into it, prints what survived, and drops it again unless `--keep`. The
source database is never touched.

A backup nobody has restored is a hypothesis. `tests/integration/backup-restore.test.ts`
runs these same two scripts against the test database on every suite run and
asserts that business records, audit history and queued jobs all come back, and
that a corrupted archive is refused before any database is created.

### Restoring for real

There is no in-place restore script, deliberately: overwriting a live database
is not something a script should make easy.

```bash
# 1. Stop both processes.
# 2. Restore into a new database and check it.
./scripts/restore-check.sh backups/expertops-<stamp>.dump --keep
# 3. Point DATABASE_URL at the restored database, start, and confirm.
# 4. Only once it is confirmed, rename or retire the old one.
```

Renaming rather than dropping means the mistake is recoverable.

---

## Migrations

```bash
npm run db:migrate          # prisma migrate deploy — applies pending migrations
npm run db:migrate:dev      # creates a new migration from a schema change
```

**Take a backup first.** Every time.

```bash
./scripts/backup.sh backups/pre-migration
npm run db:migrate
```

### Rollback is not automatic

Prisma generates forward-only migrations. There is no `migrate down`, and
several migrations in this repository cannot be reversed by definition:

| Migration | Why it cannot simply be undone |
| --- | --- |
| `candidate_actor_type` | `ALTER TYPE … ADD VALUE` cannot be removed while rows use it |
| `outreach_dispatch_progress` | Adds an enum value and back-fills state |
| `job_dedupe_scope` | Back-fills `dedupeScope` from key shapes; the original values are not recorded |

So rollback means **restore the backup**, not "run the reverse". The procedure:

```bash
# 1. Stop both processes.
# 2. Restore the pre-migration backup into a new database (above).
# 3. Point DATABASE_URL at it and start.
# 4. Redeploy the previous application version to match that schema.
```

Application code and schema have to move together. A newer build against an
older schema fails at the first query that touches a missing column, which is
loud, but it fails in front of whoever is using it.

An additive migration — a nullable column, a new table — can often be left in
place while the application is rolled back, because older code ignores it. That
is a judgement call per migration, not a rule.

---

## Interruption and recovery

These were exercised in `tests/integration/interruption-recovery.test.ts` against
real PostgreSQL, in an isolated test database.

| Scenario | How it was produced | Result |
| --- | --- | --- |
| Worker's connection dies mid-job | `pg_terminate_backend` on the job's own backend, with a partial write already made | The partial write is gone, the job did not succeed, the attempt is counted, and a replacement worker completes it — with the effect existing exactly once |
| Database connection lost between two writes | Backend terminated between them | Neither write survives. A half-applied job is the thing the design exists to prevent |
| Worker vanishes holding a batch of claims | Three jobs claimed, then the lease expired without renewal | The Worker screen reports three claims past their lease; the sweep returns all three to the queue, each having spent exactly one attempt |
| Worker restart | A new worker object on a new connection | The queue resumes, finished work is not redone |

What this does **not** cover: the database being down at startup, disk
exhaustion, and a network partition between web and database. Those need an
environment this task does not have.

---

## When something is wrong

**Start at the attention queue.** It carries the automation warning banner, so
a stalled worker is visible before anything else.

| Symptom | Look at | Usually |
| --- | --- | --- |
| Nothing is happening, queue looks quiet | `/jobs` → "Is automation running?" | No worker running |
| Jobs overdue with a worker alive | `/jobs`, failed jobs table | A handler failing repeatedly |
| A job says DEAD | `/jobs` | Retries exhausted. Fix the cause, then retry it from the table |
| Claims past their lease climbing | `/jobs` | A worker dying mid-job, repeatedly |
| Operator locked out | Wait 15 minutes | Sign-in throttling. There is no unlock command; the window passes |

### Correlation ids

Every HTTP response carries `x-correlation-id`, and every log line produced
while handling that request carries the same value. Worker jobs use their claim
id, so a retry is a separate story from its predecessor.

```bash
LOG_FORMAT=json npm run worker      # one JSON object per line
LOG_LEVEL=debug npm run dev
```

Credentials, tokens, magic links and message bodies are removed from log lines
by `src/lib/log-redaction.ts` before they are written, not by call sites
remembering to. A message body is replaced by its length, which is the
operationally useful part.

---

## Pausing things

There is no global "stop everything" switch, and inventing one during an
incident is a bad time to find out it does not work. What exists:

| To stop | Do this | Effect |
| --- | --- | --- |
| All automation | Stop the worker process | Nothing is sent, nothing expires, nothing sweeps. Queued work waits |
| One scheduled job | `/jobs` → schedules table → disable | That sweep stops; the rest continue |
| Bulk outreach | Do not approve batches | Dispatch requires an approval that a human gives |
| A single invitation | Withdraw it on the project screen | |

Stopping the worker is the blunt instrument and it is safe: jobs accumulate and
run when it comes back.

---

## What is simulated

No mail server is configured, there are no credentials for one, and no code path
opens a connection to one. `SENT` on an outbox row means the worker marked that
row; `SENT` on an invitation means a simulated message was queued for it.
Neither means anybody received anything. `src/lib/delivery-mode.ts` is the one
place that states this, and the screens read from it.
