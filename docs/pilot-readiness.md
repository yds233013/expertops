# Pilot readiness

What a controlled real-world pilot needs, what exists, what does not, and how
each item is checked. Written against commit `721f957` plus the work in this
pass.

**This is not a claim that the system is ready.** Passing tests say the
behaviour that was tested holds on one machine. Several rows below are blocked
on decisions and services that do not exist yet, and those rows are the ones
that decide whether a pilot can start.

Legend for **Blocked by**: *local* means it can be finished here; *service*
means it needs something external; *owner* means somebody has to decide.

---

## 1. Configuration and secrets

| | |
| --- | --- |
| **Exists** | `getEnv()` validates every variable at boot and refuses to start a production build on the `.env.example` `AUTH_SECRET`, a short secret, the shared demo password, exposed magic links in the UI, or plain HTTP off localhost. All problems are reported at once. |
| **Missing** | Secret storage and rotation. Secrets come from a `.env` file; there is no vault, no rotation procedure, and rotating `AUTH_SECRET` invalidates every session and unredeemed portal token at once with no staged rollover. |
| **Verified by** | `tests/unit/safeguards.test.ts` — 8 cases covering each refusal and the development case where these are the intended settings. |
| **Blocked by** | owner (where secrets live), local (rotation procedure). |

## 2. Authorization

| | |
| --- | --- |
| **Exists** | 50 capabilities across three roles, enforced server-side in the request guard rather than in the UI. Admin-only decisions are separated: publishing a rubric, resolving a reviewer conflict, approving outreach, approving payment. Cross-person access is refused by session scope, never by the id in a URL. |
| **Missing** | Nothing identified. The boundaries were re-reviewed in this pass and no gap was found. |
| **Verified by** | `tests/unit/permissions.test.ts`, `tests/api/extension-access.test.ts` (19 cases), `tests/integration/candidate-portal.test.ts`, `tests/api/support-conversations.test.ts`. |
| **Blocked by** | — |

## 3. Sign-in protection

| | |
| --- | --- |
| **Exists** | Throttling on failed sign-ins, added in this pass: 8 failures per email address and 30 per client address inside a 15-minute window, refused before any password comparison runs. Attempts against addresses that do not exist are counted too. Lockout is a refusal to attempt, not a flag on the account, so one person cannot lock another out permanently. A success clears the count for that address. |
| **Missing** | Multi-factor authentication. Password rotation policy. An operator-facing unlock; today the window simply has to pass. Client address comes from a proxy header and is trusted only to *widen* throttling, never to grant anything. |
| **Verified by** | `tests/integration/access-safeguards.test.ts` — 7 cases including the unknown-address case, the "cannot lock out a colleague" case, and address-based spraying. |
| **Blocked by** | owner (whether MFA is required for a pilot). |

## 4. Sessions

| | |
| --- | --- |
| **Exists** | Server-side session rows with a TTL, expired on read and purged by the maintenance sweep. Sign-out ends one device. `revokeSessionsFor` ends every session for one operator with a recorded reason. `deactivateOperator` deactivates and revokes in one step. |
| **Missing** | No UI for either revocation path — both are service functions, reachable from a script, not a screen. No "sign out everywhere" for a participant portal session. No account-management screen either: `user:manage` is defined and unused, so operator accounts are created from a host shell with `scripts/create-operator.ts`. |
| **Verified by** | `tests/integration/access-safeguards.test.ts` — 6 cases: expiry, sweep, one device, all devices, deactivation, and the refusals. |
| **Blocked by** | local (the UI). |

## 5. CSRF

| | |
| --- | --- |
| **Exists** | Origin/Referer check plus a signed double-submit token, applied in the request guard so a new endpoint is protected by virtue of requiring a session. Applied to login as well, since it mints a session. |
| **Missing** | Nothing identified. |
| **Verified by** | `tests/api/csrf.test.ts` — 18 cases: foreign origin, absent origin, missing header, mismatched header, forged cookie, across both session kinds. |
| **Blocked by** | — |

## 6. Access tokens

| | |
| --- | --- |
| **Exists** | Magic-link tokens travel in the URL fragment, which browsers never transmit, and are exchanged by POST. Stored as hashes. Single-use, burned in the statement that claims them. `Referrer-Policy: no-referrer` on both portal trees. |
| **Missing** | No revocation UI for an individual unredeemed link; revoking one is a database operation. |
| **Verified by** | `tests/integration/token-exposure.test.ts`, `tests/e2e/access.spec.ts` (expired, revoked, reused, cross-person), plus a browser check that a distinctive token never appears in the server log. |
| **Blocked by** | local (the UI). |

## 7. Worker liveness

| | |
| --- | --- |
| **Exists** | Every worker writes a heartbeat each tick, including idle ticks. The Worker screen leads with "Is automation running?" and the attention queue carries the same warning, covering: no worker ever, no live worker, a worker alive but failing, overdue jobs, claims past their lease, and jobs that exhausted retries. Each warning says what it costs and what to do. |
| **Missing** | Nothing pages anybody. The warnings are visible to an operator who looks. There is no alerting, no on-call, and no notification of any kind. |
| **Verified by** | `tests/integration/worker-health.test.ts` — 8 cases. |
| **Blocked by** | service (alerting), owner (who is on call — see the runbook). |

## 8. Job durability

| | |
| --- | --- |
| **Exists** | Fencing tokens per claim, bounded leases with renewal, completion inside the handler's transaction, bounded recovery of abandoned claims. Deduplication keys that identify business events are retained rather than pruned with their history. |
| **Missing** | Nothing identified. |
| **Verified by** | `worker-ownership.test.ts` (9), `dedupe-retention.test.ts` (6), `interruption-recovery.test.ts` (4), `concurrency.test.ts` (16). |
| **Blocked by** | — |

## 9. Logging

| | |
| --- | --- |
| **Exists** | Structured logs with a correlation id per request and per job claim, carried through async-local storage so a service three layers down inherits it. `x-correlation-id` is echoed on every response. Credentials, tokens, magic links and message bodies are redacted centrally before a line is written. `LOG_FORMAT=json` for one object per line. |
| **Missing** | Log shipping and retention. Lines go to stdout; nothing collects, rotates or retains them. No metrics or tracing. |
| **Verified by** | `tests/unit/safeguards.test.ts` — 7 redaction and correlation cases. |
| **Blocked by** | service (log destination). |

## 10. Backup and restore

| | |
| --- | --- |
| **Exists** | `scripts/backup.sh` and `scripts/restore-check.sh`. Custom-format dump with a checksum sidecar; restore goes into a uniquely named disposable database and never touches the source. Verified end to end against real data and in the suite. |
| **Missing** | No schedule — backups are taken by hand. No off-machine copy. No retention policy. No tested restore of a hosted database, because there is no hosted database. |
| **Verified by** | `tests/integration/backup-restore.test.ts` — business records, audit history, queued jobs and applied migrations all survive; a corrupted archive is refused before a database is created. Also run by hand against the development database: 48 experts, 14 projects, 313 audit events, 9,220 job rows restored into a disposable copy. |
| **Blocked by** | service (where backups live), owner (frequency and retention). |

## 11. Startup, shutdown, migration, rollback

| | |
| --- | --- |
| **Exists** | `docs/operations.md` covers all four, including the fact that Prisma migrations are forward-only and that three migrations in this repository cannot be reversed at all — so rollback means restoring a backup and redeploying the matching build, not running a reverse migration. |
| **Missing** | No deployment exists, so none of this has been exercised against one. No zero-downtime story: the documented rollback stops both processes. |
| **Verified by** | Interruption and restart scenarios in `interruption-recovery.test.ts`; backup/restore in `backup-restore.test.ts`. The migration rollback procedure is **documented but not exercised** — it needs a deployment to be exercised against. |
| **Blocked by** | service (hosting). |

## 12. Email

| | |
| --- | --- |
| **Exists** | An in-app outbox. `src/lib/delivery-mode.ts` is the single place stating that delivery is simulated, and the operator screens, participant portals and invitation badges read from it. "Marked delivered" means a row was updated. |
| **Missing** | Everything about real email: a provider, credentials, a sending domain with SPF/DKIM/DMARC, bounce and complaint handling, unsubscribe handling, and a retry story for transient provider failures. **None of this is connected, and until it is tested no claim about deliverability is meaningful.** Note also that transactional fencing protects database effects only; it would not stop a duplicate send once a message has left the process. |
| **Verified by** | `tests/unit/email-templates.test.ts` asserts every rendered message says it was not delivered. |
| **Blocked by** | service (provider), owner (sending domain). |

## 13. Hosting

| | |
| --- | --- |
| **Exists** | Docker Compose for PostgreSQL. A production build and start that serve the build. A complete staging deployment package — image, compose stack, TLS and tester gate, worker supervision, backup timer, health checks — built and exercised locally: [`staging-deployment.md`](staging-deployment.md). |
| **Missing** | A host. Nothing is deployed, so TLS issuance, reboot recovery, the scheduled backup and off-host copies are unexercised. Still one machine, no managed database and no failover, which is fine for synthetic staging and not for real participants. |
| **Verified by** | The staging stack run locally against an isolated database: release-step migration, sign-in, worker job processing, crash restart, backup and restore, and every development-configuration refusal. |
| **Blocked by** | owner (approve $20.00/month on Render and grant account access), then local. |

## 14. Account recovery

| | |
| --- | --- |
| **Exists** | Nothing. An operator who forgets their password cannot recover it. |
| **Missing** | The whole flow. It depends on real email, which does not exist, so it cannot be built meaningfully first. |
| **Verified by** | — |
| **Blocked by** | service (email), then local. |

## 15. Real participant data

| | |
| --- | --- |
| **Exists** | All data is synthetic. No protected personal attribute is collected, stored, inferred or used in scoring. Contact opt-out is honoured at every send site. |
| **Missing** | A lawful basis, a privacy notice, a retention and deletion policy, a subject-access procedure, and a data-processing agreement with whoever hosts it. Deletion in particular is not built: there is no "erase this person" operation, and the audit history is deliberately append-only, which is a direct tension with an erasure request. |
| **Verified by** | `tests/unit/onboarding-checklist.test.ts` asserts the absence of protected attributes. |
| **Blocked by** | owner (legal basis and policy), then local (deletion). |

---

## What blocks a pilot today

In order:

1. **Hosting.** Everything else is downstream of somewhere to run. A staging
   deployment is packaged for Render at $20.00/month
   ([`staging-deployment.md`](staging-deployment.md)); what is left is approving
   the charge and granting account access.
2. **Real email.** Without it, no participant is reachable and account recovery
   cannot exist. This is the largest untested area.
3. **A decision on participant data.** Real people mean a lawful basis and a
   deletion story, and deletion conflicts with append-only history in a way that
   needs deciding rather than coding around.
4. **Someone on call.** The warnings are good and nobody is watching them.

A pilot that avoids 2 and 3 is possible: see the runbook for a shape that uses
real operators and simulated participants.
