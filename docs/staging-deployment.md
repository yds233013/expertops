# Staging deployment

A private staging environment for ExpertOps: the Next.js app, the persistent
worker and PostgreSQL, reachable only by invited testers, carrying synthetic
data and simulated email.

Nothing here has been deployed. The configuration in `deploy/` was built and
exercised locally against an isolated database; what is still unverified is
listed under [What only a host can prove](#what-only-a-host-can-prove).

Read [`pilot-readiness.md`](pilot-readiness.md) first. Staging closes the
*hosting* blocker for a synthetic environment. It does not close real email,
participant data, or on-call.

---

## Recommendation

**One small VPS running four containers behind Caddy.** Hetzner Cloud CX23 in a
European region, or any provider's equivalent 2 vCPU / 4 GB machine.

```
                 internet
                    │  443/80
            ┌───────▼────────┐
            │     caddy      │  TLS, and the gate: one shared credential
            └───────┬────────┘  for invited testers
                    │  edge network
            ┌───────▼────────┐
            │      app       │  Next.js, no published port
            └───────┬────────┘
                    │  internal network
       ┌────────────┼─────────────┐
┌──────▼──────┐  ┌──▼───────┐  ┌──▼──────────┐
│   worker    │  │ migrate  │  │     db      │
│ persistent  │  │ one-shot │  │ no published│
│ no port     │  │ release  │  │ port at all │
└─────────────┘  └──────────┘  └─────────────┘
```

**Why not a platform.** Render, Railway and Fly all host this shape more
comfortably, and all of them break the budget for the same reason: three
always-on components priced separately. The number that settles it is managed
Postgres — Fly's cheapest Managed Postgres plan is $38/month on its own, more
than the whole budget. Render's Starter web service and background worker are
$7/month each before the database, which leaves nothing. A single VPS carries
all three for the price of one platform service.

**What that costs you.** One machine, so one thing to patch and one thing to
lose. No high availability, no managed database, no failover. For a private
staging box with synthetic data those are acceptable; for a production pilot
with real participants they are not, and the answer then is a managed database
rather than a bigger VPS.

---

## Cost

Assumptions: one environment, 5–10 invited testers, a few hundred megabytes of
synthetic data, well under 100 GB of traffic a month, backups kept 14 days.

| Item | Monthly |
| --- | --- |
| Hetzner CX23 — 2 vCPU, 4 GB RAM, 40 GB NVMe, IPv4 included | €4.49–€5.99 (~$5.00–6.70) |
| Hetzner automated server snapshots (20% of the server price, optional) | €0.90–€1.20 (~$1.00–1.35) |
| Backblaze B2 for off-host dumps — first 10 GB free, then $6.95/TB | $0.00 |
| DNS record on a domain you already own | $0.00 |
| **Total** | **~$5–8/month** |

Under the $20 ceiling with room for a bigger machine if 4 GB turns out to be
tight. No credits, no trials, no free tier that expires: this is the steady
price.

Two things to check before committing, because I could not read them from an
official page:

- **Hetzner renders prices in JavaScript**, so the figures above come from
  third-party trackers in September 2026, and they disagree by about €1.50
  because of a price increase during 2026. Confirm the real number in the
  Hetzner console at checkout. The decision does not change either way.
- **Traffic beyond the included allowance** is billed per TB. A staging box
  with ten testers will not approach 20 TB.

If the budget were $0, none of this works: every provider that keeps a worker
and a database running continuously charges for it, and the free tiers that
look like exceptions either sleep the process or expire the database.

---

## What is in the repository

| Path | What it is |
| --- | --- |
| `Dockerfile` | One image. The app, the worker and the release step all run it. |
| `deploy/docker-compose.staging.yml` | The four services, two networks, the release ordering. |
| `deploy/docker-compose.local.yml` | Rehearsal overlay: publishes the app on localhost, drops Caddy. |
| `deploy/Caddyfile` | TLS, the tester gate, security headers. |
| `deploy/staging.env.example` | Every variable, with placeholders. |
| `deploy/staging-backup.sh` | Nightly dump, checksum, retention, optional off-host copy. |
| `deploy/staging-restore-check.sh` | Restores a dump into a throwaway database and counts what survived. |
| `deploy/staging-healthcheck.sh` | HTTP, containers and worker heartbeat in one command. |
| `deploy/systemd/` | Start at boot; run the backup nightly. |
| `scripts/bootstrap-operator.ts` | Creates the first operator. Refuses to run twice. |
| `scripts/staging-fixtures.ts` | A small, obviously synthetic dataset. |

---

## HTTPS, access and private database connectivity

**HTTPS.** Caddy gets a certificate from Let's Encrypt on first start and
renews it unattended. `STAGING_HOSTNAME` must already resolve to the host
before the first start or the challenge fails. If you would rather not touch a
real domain yet, `staging.<dashed-ip>.sslip.io` resolves to the IP in its own
name and needs no DNS record at all.

HTTPS is not decoration here. The session cookie is issued `Secure`, so over
plain HTTP on a non-localhost host browsers drop it and nobody can stay signed
in. The configuration guard refuses to start on an `http://` base URL for the
same reason.

**Invited testers only.** Caddy asks for one shared credential before anything
else, including `/api/health`. Generate the hash on the host:

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'the-shared-password'
```

Put the hash in `TESTER_PASSWORD_HASH`; hand the plaintext to testers out of
band. Behind that gate the application's own sign-in still applies, and expert
and candidate portals still need their single-use links. The gate keeps
strangers and crawlers out; it is not the authentication.

**Private database.** The `db` service publishes no port. It sits on the
`internal` network with the app, the worker and the release step; Caddy is on
`edge` and cannot reach it. From off the host there is no route to PostgreSQL
at all — administration goes through `docker compose exec db psql` over SSH.

---

## The worker, and what keeps it running

Three layers, because they fail at different levels:

| Failure | What handles it |
| --- | --- |
| The worker process crashes | Docker's `restart: unless-stopped` starts a new container |
| The host reboots | `expertops-staging.service` brings the stack up at boot |
| The worker is up but stuck | Heartbeat: the Worker screen, the attention queue, `staging-healthcheck.sh` |

The worker runs `node_modules/.bin/tsx src/server/worker/main.ts` directly, not
`npm run worker:start`. That detail matters: with npm as PID 1, `docker stop`
produced `npm error signal SIGTERM` and the worker's own shutdown handler never
ran, so every deploy abandoned whatever job was in flight for the lease reaper
to clean up. Running the binary directly, the handler runs, the poll loop stops
and the job in flight finishes inside its lease.

`stop_grace_period: 30s` gives it room. `init: true` puts a real init at PID 1
to reap children.

One thing to know when testing this by hand: `docker kill` from the host counts
as a *manual stop*, and Docker deliberately does not apply the restart policy
to one. A real crash — the process dying on its own — does restart. Verified
locally: killing the worker's node process took `RestartCount` 0 → 1 and the
heartbeat resumed within seconds.

---

## Secrets

`deploy/staging.env` lives on the host, `chmod 600`, owned by the deploy user.
It is gitignored (`deploy/*.env`), and `deploy/staging.env.example` carries
placeholders only.

The application refuses to start on development values. All of these were
checked against the built image:

| Setting | Refusal |
| --- | --- |
| `AUTH_SECRET` still the `.env.example` placeholder | "AUTH_SECRET is still the placeholder" |
| `AUTH_SECRET` shorter than 32 characters | "must be at least 32 characters in production" |
| `SEED_DEMO_PASSWORD` still `demo-password-123` | "Seeded demo accounts must not exist in production" |
| `EXPOSE_PORTAL_LINKS_IN_UI` true | "prints single-use magic links in the operator UI" |
| `APP_BASE_URL` plain HTTP off localhost | "Session and portal links would travel unencrypted" |
| `DATABASE_URL` naming `expertops`, `expertops_test` or `expertops_e2e` | "A deployment needs its own database" |
| `DATABASE_URL` carrying `expertops:expertops` | "still carries the development database credentials" |

The last two are new. They exist because the realistic accident is not a weak
password, it is a developer's `.env` travelling to a server — and the test
suite truncates every table in the databases it recognises.

Rotation is still manual and still disruptive: changing `AUTH_SECRET`
invalidates every session and every unredeemed portal link at once. There is no
staged rollover. For staging that is a re-send; for a pilot it needs a plan.

---

## The first operator

There is no public registration, on purpose. The first account is created once,
by somebody with shell access:

```bash
cd /opt/expertops/deploy
docker compose -f docker-compose.staging.yml --env-file staging.env \
  run --rm --no-deps \
  -e BOOTSTRAP_OPERATOR_EMAIL=ops@your-org.example \
  -e BOOTSTRAP_OPERATOR_NAME="Your Name" \
  app npx tsx scripts/bootstrap-operator.ts
```

It generates a 24-character password, prints it once, and never writes it
anywhere. Supply `BOOTSTRAP_OPERATOR_PASSWORD` instead if you want to choose
one; it must be at least 16 characters and must not be the demo password.

The script refuses to run if any operator already exists, and refuses to run
against the development or test databases. Every account after the first is
created by an operator who is already signed in.

Optional, afterwards:

```bash
docker compose … run --rm --no-deps app npx tsx scripts/staging-fixtures.ts
```

Two synthetic experts and one synthetic project, every record prefixed
`SYNTHETIC`, no operator accounts. Idempotent.

---

## Deploying

First time:

```bash
ssh deploy@staging-host
sudo mkdir -p /opt/expertops && sudo chown "$USER" /opt/expertops
git clone <your-mirror> /opt/expertops && cd /opt/expertops/deploy
cp staging.env.example staging.env && chmod 600 staging.env && "$EDITOR" staging.env

docker compose -f docker-compose.staging.yml --env-file staging.env up -d --build

sudo cp systemd/expertops-*.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now expertops-staging.service expertops-backup.timer
```

Then bootstrap the operator, and browse to `https://$STAGING_HOSTNAME`.

Every deploy after that:

```bash
cd /opt/expertops && git pull
cd deploy
./staging-backup.sh                       # before the schema moves
docker compose -f docker-compose.staging.yml --env-file staging.env up -d --build
./staging-healthcheck.sh
```

`up -d --build` rebuilds the image, runs `migrate` to completion, and only then
recreates the app and the worker. The app and the worker never migrate anything
themselves, so two of them starting at once cannot race, and a failed migration
stops the deploy instead of leaving half a schema behind a running app.

### Migrations and rollback

Prisma migrations are forward-only. There is no `migrate down`, and three
migrations in this repository cannot be reversed at all — see the table in
[`operations.md`](operations.md#rollback-is-not-automatic). Rollback therefore
means restoring a backup, not running a reverse migration:

```bash
cd /opt/expertops/deploy
docker compose -f docker-compose.staging.yml --env-file staging.env stop app worker
./staging-restore-check.sh /var/backups/expertops/<pre-deploy>.dump --keep   # prove it first
# point POSTGRES_DB at the restored copy, or restore over the database, then:
git checkout <previous-commit>
docker compose -f docker-compose.staging.yml --env-file staging.env up -d --build
```

**Compatibility limits, plainly:**

- Code and schema move together. A **newer build on an older schema** fails at
  the first query touching a missing column. It fails loudly, in front of a
  tester.
- An **older build on a newer schema** usually works when the migration was
  additive — a nullable column, a new table — because older code ignores what
  it does not know about. That is a judgement per migration, not a rule, and
  the three listed above are not additive.
- **PostgreSQL 16** is what the compose file pins and what the dumps are taken
  with. `pg_restore` will not restore a dump into an older server.
- Restoring a backup **loses everything after it was taken**. On staging that
  is synthetic data and a re-run of the fixtures.

---

## Backups

`expertops-backup.timer` runs nightly at 02:15 UTC:

- `pg_dump -Fc` inside the database container — no published port needed
- a `.sha256` sidecar beside every dump
- refuses to keep a dump under 1 KB, which is what a failed dump looks like
- deletes dumps older than `RETENTION_DAYS` (14 by default)
- copies off-host with `rclone` when `RCLONE_REMOTE` is set, and **says in the
  log when it is not**, because a backup on the same disk as the database is
  not a backup

Restoring is the same script that proves the backup works:

```bash
./deploy/staging-restore-check.sh /var/backups/expertops/expertops-staging-….dump
```

It verifies the checksum, creates a uniquely named database, restores into it,
prints the row counts that matter, and drops it again. It never touches the
source. Exercised locally: checksum OK, then `1 operator, 2 experts, 1 project,
4 activity events, 39 jobs, 9 migrations` restored into a disposable copy.

Off-host storage is an owner decision. B2 is free at this size; a Hetzner
Storage Box works too. Until one is configured, a lost server loses the
backups with it.

---

## Health, and how the operator finds out

Three checks, one command:

```bash
./deploy/staging-healthcheck.sh
#   ok  app answered: {"status":"ok","databaseLatencyMs":21,…}
#   ok  db is running
#   ok  app is running
#   ok  worker is running
#   ok  worker heartbeat 0s old
#   staging: healthy
```

Non-zero exit when anything fails, so cron or a monitor can act on it. The
heartbeat check is the one that catches a worker that is running but wedged,
which the container state cannot see.

In the application: the Worker screen leads with "Is automation running?" and
the attention queue carries the same warnings, including no live worker, a
worker alive but failing, claims past their lease, and jobs that exhausted
retries.

**Nothing pages anybody.** That is still true, and it is the honest gap. The
smallest thing that closes it, and the owner decisions it needs:

1. An uptime monitor that fetches `https://$STAGING_HOSTNAME/api/health` every
   few minutes with the tester credential, and emails or texts on failure. Free
   tiers cover this. **Needs: an account, and a named person to notify.**
2. `expertops-backup.service` failures surface in `systemctl --failed` and the
   journal. Nothing reads those unless somebody looks. **Needs: either a
   monitor that runs `staging-healthcheck.sh`, or a habit.**
3. Container logs go to stdout and are rotated by Docker. Nothing ships them.
   **Needs: a log destination, or acceptance that logs die with the host.**

---

## What was verified locally

Against `expertops_staging` on an isolated volume, with the development
database untouched throughout:

| Check | Result |
| --- | --- |
| Image builds and runs the app, worker and release step | pass |
| `migrate` applies all 9 migrations, exits 0, app and worker start after it | pass |
| App health check green; `/api/health` answers | pass |
| Worker boots, registers schedules, processes jobs | pass |
| Sign-in: wrong password 401, correct password 200, `HttpOnly` + `Secure` cookie | pass |
| First-operator bootstrap; second attempt refused | pass |
| Synthetic fixtures load and are idempotent | pass |
| Graceful stop runs the worker's SIGTERM handler | pass, after the npm fix |
| Crash recovery: killed process, container restarted, heartbeat resumed | pass |
| Backup, checksum, restore into a disposable database | pass |
| Demo secret, demo password, exposed links, dev database name and dev credentials | all refused |

## What only a host can prove

- Let's Encrypt issuance and renewal for a real hostname.
- The Caddy tester gate in front of a real certificate.
- Reboot recovery through `expertops-staging.service`.
- The systemd backup timer firing on schedule, and `rclone` to a real bucket.
- Anything about performance on 4 GB of RAM with real testers.
