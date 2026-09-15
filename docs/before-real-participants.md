# Before real participants

This deployment is open for review. It is **not** ready to accept applications
from people who exist, and this file is the list of what would have to be true
first. Nothing here is started, and none of it should be assumed.

The software supports the candidate and operator workflow. That is a different
claim from the deployment being fit to hold a stranger's data.

---

## 1. Email delivery, and recovery when it fails

Today every message is written to an in-app outbox and marked "delivered" by a
background job. There is no SMTP client, no third-party API and no network call
on that path. A candidate who applies is told this before they type anything,
because otherwise they would wait for a message that cannot arrive.

Needed:

- A real provider, configured with a verified sending domain, SPF, DKIM and
  DMARC — otherwise single-use sign-in links land in spam, which is worse than
  not sending them.
- Bounce and complaint handling, wired to the record. A bounced address is a
  candidate who will never see their screening, and somebody has to be told.
- A resend path an operator can trigger, and a rate limit on it.
- What happens when the provider is down: queue, retry, and a visible failure
  rather than a message silently marked sent.

Until then the operator hands the link over directly, which is the current
design and is deliberate.

## 2. Privacy and retention

An application is a person writing about their working life. Right now it is
kept indefinitely, because nothing deletes it.

Needed, as decisions before code:

- A retention period for applications, screening answers and rejected
  candidates, and an owner for that decision.
- A privacy notice on the application form saying who holds the data, why, for
  how long, and who sees it. The form currently says the honest minimum — that
  this is a demo — and nothing more.
- A lawful basis, and a record of it, if anyone in scope is in a jurisdiction
  that requires one.
- A decision about whether screening answers are visible to reviewers other
  than the assigned one, and for how long after a decision.

## 3. Deletion

There is no deletion path in this build. A candidate cannot ask for their record
to be removed, and an operator cannot remove it.

Needed:

- A request route, and a defined response time.
- A decision on what "delete" means against an append-only activity history. The
  history is load-bearing — it is what makes every decision attributable — so
  the likely answer is redaction of personal fields with the event left standing,
  and that needs to be designed rather than improvised.
- The same decision for the simulated outbox, which holds message bodies.
- Cascade behaviour: an application deleted while a screening is open, an expert
  deleted while holding a seat.

## 4. Hosted backups and recovery

**Unverified, and not configured.** The database is a single Railway Postgres
instance. Backup availability and restore have never been tested on this
deployment, and no paid backup add-on has been enabled.

Needed:

- A backup that exists, on a schedule, somewhere other than the same service.
- A restore actually performed into a scratch database, with the result checked.
  An untested backup is a belief, not a backup.
- A recovery-point and recovery-time objective somebody has agreed to.

`scripts/backup.sh` and `scripts/restore-check.sh` exist and work against a local
database. They have not been run against the hosted one.

## 5. Smaller things that still matter

- **Payment.** Preparation and CSV export only. There is no `PAID` state in the
  schema and no action that moves money. Anything beyond export is a separate
  build with its own approval path.
- **Rate limiting.** The application endpoint is limited per email and per IP,
  and sign-in is throttled per address and per client. Neither has been load
  tested.
- **Contact preferences.** Structured and enforced, but every existing record
  reads `UNKNOWN` — nobody has been asked. Real participants would need to be.
- **Accessibility.** Checked mechanically at two viewport widths for overflow,
  control naming and focus visibility. That is not an audit.
- **Concurrency.** Exercised at 100 managed records. Not at 100 concurrent
  people.

---

Nothing in this list is complete, and none of it should be described as complete.
