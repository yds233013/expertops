# Staging deployment

A private staging environment for ExpertOps: the Next.js app, the persistent
worker and PostgreSQL, reachable only by invited testers, carrying synthetic
data and simulated email.

**This is deployed on Railway.** See
[Deployed on Railway](#deployed-on-railway) for what is running, what it costs
and how it was verified. Everything else in this document — the Render
blueprint, the provider comparison, the DigitalOcean/Hetzner preflight — is
**superseded**; read it as history, not as a recommendation. The self-hosted VPS
arrangement is kept because the packaging, the guards, the backup and restore
scripts, the operator tooling and the tester model are all shared with the
Railway deployment, and because it remains the fallback.

Railway rather than Render because Railway is where the account's other project
already lives. Render was chosen on 12 September 2026 on the assumption that it
hosted Ledger AI; inspecting the account showed Ledger AI runs on Railway and
there is no Render account at all.

Read [`pilot-readiness.md`](pilot-readiness.md) first. Staging closes the
*hosting* blocker for a synthetic environment. It does not close real email,
participant data, or on-call.

---

## Recommendation — superseded

> Superseded by [Deploying on Render](#deploying-on-render). Kept for the
> reasoning and the prices, which were verified at the time.

**One small VPS running four containers behind Caddy.** A DigitalOcean Basic
Droplet — 1 vCPU, 2 GiB RAM, 50 GiB SSD, 2 TB transfer — at **$12.00/month**.

This was Hetzner until the deployment preflight. Hetzner is cheaper on paper and
would still be the better buy if it were buyable, but on their own site today
every shared-vCPU plan in both the Cost-Optimized and Regular Performance lines
reads *"This product is currently unavailable. Please check back later."*, and
no plan renders a price at all — the figures are injected client-side and did
not load. A provider whose price cannot be read and whose servers cannot be
ordered is not a recommendation. DigitalOcean publishes a rendered price table,
which is the number in the cost section below.

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

## Deployed on Railway

Live at **https://web-production-09e7e.up.railway.app**, behind the tester gate.
Project `expertops-staging` in the workspace "Yash Shah's Projects", environment
`production`, region `ams`. Deployed 13 September 2026.

Ledger AI's project `jubilant-hope` is untouched and shares nothing with this
one: separate project, separate PostgreSQL instance, separate credentials,
separate private network. The only thing the two share is the workspace usage
pool and the one plan fee.

| Service | What it runs | Memory in use |
| --- | --- | --- |
| `web` | `next start` on port 3000, health check `/api/health` | 168 MB |
| `worker` | `tsx src/server/worker/main.ts` | 178 MB |
| `Postgres` | Railway PostgreSQL 18, 0.1 GB volume | 109 MB |

### Cost

The Hobby plan is $5.00/month and includes $5.00 of usage. Memory is metered at
$0.000231/GB/min, about $9.98 per GB-month; CPU and egress are rounding errors
at this size.

| | Monthly |
| --- | --- |
| Ledger AI, projected from the current period | $3.36 |
| ExpertOps, 455 MB steady state | ~$4.50 |
| Usage total | ~$7.90 |
| Less the $5.00 included | −$5.00 |
| **Paid on top of the $5.00 plan fee** | **~$2.90** |

A **soft** usage limit of $10.00 is set on the workspace. Soft means an email
alert. There is deliberately no hard limit: a hard limit suspends resources
across the whole workspace, which would take Ledger AI down along with
ExpertOps.

### How the services are configured

Neither service reads a `railway.json`. The settings are held on the service
instances and were applied through the API:

```
railway api 'mutation($sid:String!,$eid:String,$in:ServiceInstanceUpdateInput!){
  serviceInstanceUpdate(serviceId:$sid,environmentId:$eid,input:$in)}' \
  --raw-var "sid=<service id>" --raw-var "eid=<environment id>" \
  --var 'in={"startCommand":"...","healthcheckPath":"/api/health",
             "preDeployCommand":["npx prisma migrate deploy"],
             "restartPolicyType":"ON_FAILURE","numReplicas":1}'
```

Two things about the start command are worth knowing before changing it. It is
**not** run through a shell, so `--port ${PORT:-3000}` reaches Next.js as a
literal string and the container crash-loops; the port is written out. And
`railway redeploy` replays the previous deployment's settings snapshot, so a
settings change needs a fresh `railway up`, not a redeploy.

Only `web` carries the pre-deploy command, so migrations run exactly once per
release and the two services can never race each other to migrate.

### Deploying a change

`railway up --service web --ci` and `railway up --service worker --ci` from the
repository root. There is no GitHub connection and no automatic deploy: the CLI
tars the working directory and uploads it, which is why `.railwayignore` exists
alongside `.dockerignore`. Keep the two in step.

### Seeding

The first operator and the synthetic fixtures were created by temporarily
setting the worker's pre-deploy command to run
`scripts/bootstrap-operator.ts` and then `scripts/staging-fixtures.ts`, because
Railway's shell access requires registering an SSH key on the account and the
database has no public proxy — by design. The command and the bootstrap
variables were removed immediately afterwards. `bootstrap-operator.ts` refuses
to run once any operator exists, so leaving it in place would have failed every
later deploy.

---

## Deploying on Render — superseded


`render.yaml` at the repository root is the blueprint. Three billable services
and one shared environment group.

| Service | Type | Plan | Monthly |
| --- | --- | --- | --- |
| `expertops-staging` | web | `0.5c-512mb` — 0.5 CPU, 512 MB | $7.00 |
| `expertops-staging-worker` | worker | `0.5c-512mb` — 0.5 CPU, 512 MB | $7.00 |
| `expertops-staging-db` | Postgres 16 | `0.1c-256mb` — 256 MB, 1 GB storage | $6.00 |
| Hobby workspace | — | — | $0.00 |
| **Total** | | | **$20.00/month** |

Read from Render's pricing page on 12 September 2026. Sales tax is added
according to the billing address. Included on Hobby and not expected to be
exceeded by a staging box: 5 GB bandwidth (then $0.15/GB), 500 build-pipeline
minutes (then $5 per 1,000), 1 GB of Postgres storage (then $0.30/GB), and 2
custom domains — this uses the free `onrender.com` hostname, so none.

Neither free tier is usable here. Background workers have no free plan at all,
Render's free Postgres expires, and the pre-deploy command — the whole release
gate — is documented as available only for **paid** services.

### The release step, and what rollback really does

`preDeployCommand: npx prisma migrate deploy` runs after the build and before
the new version receives traffic, on a separate instance. Render's own words:
*"If any command fails or times out, the entire deploy fails. Any remaining
commands do not run."* A failed migration therefore leaves the previous version
serving, which is the guarantee compose's `depends_on` never actually gave.

Both the web service and the worker carry that command. A blueprint deploys its
services in parallel, so gating only the web service would let the worker start
against an un-migrated schema. `prisma migrate deploy` takes a PostgreSQL
advisory lock, so the two runs serialise and the second is a no-op that also
proves the schema is current.

**Rollback was verified against the documentation rather than assumed, and it is
narrower than it sounds.** Render's rollback page never mentions migrations or
pre-deploy commands at all. A rollback *"kicks off a new deploy using the target
deploy's build artifact"* — code only. It does not re-run migrations and it does
not revert the database. Disks *"retain state between all deploys and cannot be
rolled back."*

So the rule on Render is the same rule as everywhere else in this repository,
and the platform does not soften it:

- **Additive migration** — a nullable column, a new table: rolling the code back
  is usually safe, because the older build ignores what it does not know about.
- **Anything else** — including the three migrations listed in
  [`operations.md`](operations.md#rollback-is-not-automatic): rolling the code
  back is **not** enough. Restore the database first, from a dump or from
  Render's point-in-time recovery, then roll the code back to match.
- `autoDeploy` is set to `false`. Render warns that rolling back does not
  disable automatic deploys, so with it on, the next push would quietly
  reinstate the commit just reverted.

### The gate, on a platform with no proxy of ours

Caddy is not in the picture on Render: the service is on the public internet as
soon as it deploys. The same shared gate therefore runs in `src/middleware.ts`,
in front of every route, before any of them resolve a session. Set
`STAGING_GATE_USER` and `STAGING_GATE_PASSWORD` and it turns on; leave either
unset and there is no gate, which is what development and the test suite want.

`/api/health` is exempt, because Render's health check cannot send credentials.
That publishes three integers — counts of synthetic experts, projects and
pending jobs — to anyone who finds the URL. That is the trade, and it is the
only thing the gate lets past.

Everything else about testers is unchanged: one shared credential to reach the
site at all, then individual operator accounts created with
`scripts/create-operator.ts`, and single-use magic links copied from the outbox
for the expert journey.

### What Render replaces, and what it does not

| Concern | Self-hosted | On Render |
| --- | --- | --- |
| TLS | Caddy and Let's Encrypt | managed, on `*.onrender.com` |
| Tester gate | Caddy basic auth | the same gate in middleware |
| Private database | no published port | `ipAllowList: []` — Render services only |
| Release step | compose ordering | `preDeployCommand`, a real gate |
| Worker supervision | Docker restart policy | Render restarts a failed worker |
| Boot recovery | a systemd unit | the platform's job |
| Backups | `staging-backup.sh` on a timer | Render's logical backups and PITR, **plus** the same script if you want a dump you hold yourself |
| Building | on the host, needs swap on 2 GB | Render's build pipeline |

The scripts in `deploy/` still work against a Render database — point
`DATABASE_URL` at the external connection string — and the operator and fixture
scripts run from the Render shell exactly as they do in a container.

---

## Container layout

This is the self-hosted compose stack. On Render the equivalent is two services
and a managed database; see [Deploying on Render](#deploying-on-render).

Five services. Four run continuously; one runs and exits.

**Long-running**

| Container | Image | Command | Published | Networks | Restart | Health |
| --- | --- | --- | --- | --- | --- | --- |
| `caddy` | `caddy:2-alpine` | Caddy default | **80, 443** | `edge` | `unless-stopped` | Caddy's own proxy probe on `/api/health` |
| `app` | `expertops:staging` | `node_modules/.bin/next start --port 3000` | none | `edge`, `internal` | `unless-stopped` | image `HEALTHCHECK` fetches `/api/health` every 30s |
| `worker` | `expertops:staging` | `node_modules/.bin/tsx src/server/worker/main.ts` | none | `internal` | `unless-stopped` | disabled in Docker; liveness is the heartbeat row |
| `db` | `postgres:16-alpine` | Postgres default | **none** | `internal` | `unless-stopped` | `pg_isready` every 10s |

**One-shot**

| Container | Image | Command | Restart | Gate |
| --- | --- | --- | --- | --- |
| `migrate` | `expertops:staging` | `npx prisma migrate deploy` | `no` | starts after `db` is healthy; `app` and `worker` start only on its **successful exit** |

The release step is the whole point of that last row. Neither long-running
process migrates anything, so restarting the app does not touch the schema and
two containers starting together cannot race each other. A failed migration
leaves the previous app and worker running on the previous schema rather than
half-upgrading behind a live site.

`caddy` sits only on `edge`, so nothing that gets through the proxy can address
the database. `db` publishes no port on any interface: administration is
`docker compose exec db psql` over SSH, and there is no route to Postgres from
off the host.

---

## Cost — superseded

> The live figure is $20.00/month on Render, in
> [Deploying on Render](#deploying-on-render). What follows is the
> DigitalOcean/Hetzner preflight, kept as history.

Assumptions: one environment, 5–10 invited testers, a few hundred megabytes of
synthetic data, well under 100 GB of traffic a month, database dumps kept 14
days.

Every figure below was read from the provider's own pages on 12 September 2026.

| Item | Monthly | Source |
| --- | --- | --- |
| DigitalOcean Basic Droplet, Regular CPU — 1 vCPU, 2 GiB, 50 GiB SSD, 2 TB transfer | $12.00 | official pricing table |
| Droplet backups — usage-based, daily, $0.03/GiB of restorable size | ~$0.30 | official backup pricing |
| …or Droplet backups — basic plan, weekly, 20% of the Droplet price | $2.40 | official backup pricing |
| Backblaze B2 for off-host database dumps — first 10 GB free | $0.00 | official pricing |
| DNS record on a domain you already own, or `sslip.io` | $0.00 | — |
| **Total before tax** | **$12.30–$14.40** | |

Under the $20 ceiling either way. No credits, no trial, nothing that expires.

**Tax is added on top and depends on your billing country.** DigitalOcean
charges by the account's tax location, invoices in USD only, and lets a
registered business remove it with a VAT or GST ID. From their tax table:
United Kingdom 20%, Switzerland 8.1%, Norway 25%, Australia 10%, Singapore 9%,
United Arab Emirates 5%; the European Union, the United States and Canada are
listed as *varies* by state or member country. At 20% the $12.30 option becomes
about **$14.76/month**; at 0% with a valid VAT ID it stays $12.30. I cannot
finish this line without knowing your billing country — it is the first item on
the owner checklist.

**Two things you confirm at checkout, not here:**

1. **The tax line on the first invoice.** It is computed from the address on
   the account, which does not exist yet.
2. **Region availability.** The price is the same across regions; pick the one
   nearest your testers.

**What the price does not include:** a domain. If you do not already own one,
budget roughly $1/month at a registrar and confirm the figure there — I have
not verified registrar pricing. `sslip.io` avoids it entirely.

**2 GiB is enough to run this, not to build it.** The four containers idle at
roughly 700 MB–1 GB together. `next build` on top of that is what would fail.
Build the image on your machine and ship it, or add 2 GB of swap on the host
before the first build — see
[How the source reaches the server](#how-the-source-reaches-the-server).

**Why not a platform.** Render, Railway and Fly all host this shape more
comfortably, and all of them break the budget for the same reason: three
always-on components priced separately. The number that settles it is managed
Postgres — Fly's cheapest Managed Postgres plan is $38/month on its own, more
than the whole budget. Render's Starter web service and background worker are
$7/month each before any database. A single VPS carries all three for the price
of one platform service.

If the budget were $0, none of this works: every provider that keeps a worker
and a database running continuously charges for it, and the free tiers that
look like exceptions either sleep the process or expire the database.

---

## How the source reaches the server

Nothing has been pushed anywhere. There is no clone URL, and creating one is a
decision rather than a step: a private repository on GitHub or GitLab means an
account, a deploy key and a third party holding the code.

Three ways to get commit `215c351` onto the host, in the order I would try them:

**1. A git bundle over scp.** One file, full history, no third party, and the
commit id proves you got what was reviewed.

```bash
# on your machine
git bundle create expertops-source-215c351.bundle HEAD --branches
scp expertops-source-215c351.bundle deploy@staging-host:/tmp/

# on the host
git clone /tmp/expertops-source-215c351.bundle /opt/expertops
cd /opt/expertops && git log --oneline -1        # expect 215c351
```

Later updates are another bundle: `git bundle create update.bundle 215c351..HEAD`
then `git pull /tmp/update.bundle main` on the host.

**2. A prebuilt image, so the 2 GiB host never compiles anything.** Pair it with
the bundle above, which still carries `deploy/` and the scripts.

```bash
docker save expertops:staging | gzip | ssh deploy@staging-host 'gunzip | docker load'
```

Then set `EXPERTOPS_IMAGE=expertops:staging` in `staging.env` so compose uses
the loaded image instead of building.

**3. A bare repository on the staging host itself.** If you want `git push`
deploys without a third party:

```bash
ssh deploy@staging-host 'git init --bare /srv/expertops.git'
git remote add staging deploy@staging-host:/srv/expertops.git
git push staging main
```

**The decision you owe me:** whether this code is published to a private
repository at a host you already use, or stays on your machines and moves by
bundle. Everything above works without publication; only option 3's convenience
and any future CI depend on it.

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
| `render.yaml` | The Render blueprint: web, worker, Postgres, shared env group. |
| `src/server/http/staging-gate.ts` | The shared tester gate, for hosts with no proxy of ours. |
| `scripts/bootstrap-operator.ts` | Creates the first operator. Refuses to run twice. |
| `scripts/create-operator.ts` | Adds operator accounts after the first, with a role. |
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
band. The gate keeps strangers and crawlers out. It is not the authentication,
and it identifies nobody: everyone shares it.

### How a tester reaches each journey

Two layers, and they stay separate on purpose. Everyone passes the same outer
gate; who they are is decided inside the application, per person.

| | Outer gate (shared) | Inside the application (individual) |
| --- | --- | --- |
| **Operator journey** | `TESTER_USERNAME` + password | Their own operator account: email, password and role, created with `scripts/create-operator.ts`. Never shared, never seeded. |
| **Expert journey** | the same shared credential | A single-use magic link addressed to that expert. No password exists for an expert account, by design. |

**Operator testers.** Bootstrap the first operator once, then add one account
per tester:

```bash
docker compose -f docker-compose.staging.yml --env-file staging.env \
  run --rm --no-deps \
  -e OPERATOR_EMAIL=sam@example.com \
  -e OPERATOR_NAME="Sam Okafor" \
  -e OPERATOR_ROLE=OPERATOR \
  app npx tsx scripts/create-operator.ts
```

`VIEWER` for read-only observers, `OPERATOR` for day-to-day work, `ADMIN` only
for the approvals that need a second person — and at least two `ADMIN`s, or
nothing can be approved, because an operator cannot approve their own batch.
Attribution in the activity history is per account, so shared logins would make
the history lie.

This runs from the host shell because **there is no account-management screen**:
`user:manage` exists as a capability and nothing uses it yet. That is a real
gap, found during the deployment preflight — without this script a deployment
could only ever have the one account `bootstrap-operator.ts` creates. Adding the
screen is application work for later; creating accounts from the host is how it
works today.

**Expert testers.** Invite the expert from a project as usual. The worker
renders the invitation into the simulated outbox, and the operator opens
*Outbox* and copies the `…/portal/enter#t=…` line out of the message body, then
sends it to the tester out of band.

Two details that matter on staging:

- `EXPOSE_PORTAL_LINKS_IN_UI` is forced false, so the convenience
  "Portal link (dev only)" row is hidden. The link is still readable in the
  message body, which is where the operator copies it from.
- The tester needs **both**: the shared gate credential to load the page at all,
  and the magic link to be recognised as that expert. The link is single-use, so
  a second tester cannot reuse it — invite them separately.

This mirrors production rather than working around it: an operator can always
issue a portal link for an expert, which is how the real product works, and on
staging every expert is synthetic anyway.

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
| Adding a `VIEWER` account, then signing in as it: 17 read-only capabilities | pass |
| Operator creation refuses an unknown role and a duplicate email | pass |
| Synthetic fixtures load and are idempotent | pass |
| Graceful stop runs the worker's SIGTERM handler | pass, after the npm fix |
| Crash recovery: killed process, container restarted, heartbeat resumed | pass |
| Backup, checksum, restore into a disposable database | pass |
| Demo secret, demo password, exposed links, dev database name and dev credentials | all refused |

## What only a host can prove

The list below belongs to the superseded VPS arrangement. On Railway, TLS,
process supervision and restart-on-crash are the platform's, and the tester gate
is the application's own middleware rather than Caddy — all of which is exercised
by the run recorded in [`staging-verification.md`](staging-verification.md).

- Let's Encrypt issuance and renewal for a real hostname.
- The Caddy tester gate in front of a real certificate.
- Reboot recovery through `expertops-staging.service`.
- The systemd backup timer firing on schedule, and `rclone` to a real bucket.
- Anything about performance on 4 GB of RAM with real testers.

Still unproven on Railway: scheduled backups of the managed PostgreSQL, restore
from one of those backups, and behaviour under more than one concurrent tester.
