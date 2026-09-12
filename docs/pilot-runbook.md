# Controlled pilot runbook

A pilot shaped to what actually works today. Read
[`pilot-readiness.md`](pilot-readiness.md) first: it says what is missing, and
this runbook is built around those gaps rather than over them.

**The shape.** Real operators doing real coordination work, on one real project,
with **simulated participants** — colleagues playing the expert and candidate
roles, reachable because someone hands them a link, not because an email
arrives. That is the largest pilot possible without a mail provider, hosting, or
a decision on real participant data.

What this pilot can tell you: whether the workflow matches how the work is
actually done, whether the automation helps, and whether an operator can run a
day on it. What it cannot tell you: anything about deliverability, real
participant behaviour, or operating at any scale.

---

## Before day one

| | Who | Done when |
| --- | --- | --- |
| Decide the one project | Pilot owner | A real shortage, 2–3 seats, a real deadline |
| Name the operators | Pilot owner | Two people, one of them an admin — approval needs a second pair of eyes and most gates enforce it |
| Name the participants | Pilot owner | 3–5 colleagues who will act as candidates and experts |
| Name who watches failures | Pilot owner | One person, named, with the hours they cover |
| Take a backup | Operator | `./scripts/backup.sh backups/pilot-day-zero` |
| Confirm both processes run | Operator | `/jobs` says "Is automation running?" with a worker reporting |

---

## Access

**Operators** sign in at `/login` with an email and password. Accounts are
created by an existing operator; there is no self-service registration and **no
password recovery** — an operator who forgets their password needs another
operator to create them a new account. Plan for that before it happens.

Sign-ins are throttled: eight failures on one address inside fifteen minutes
locks that address out until the window passes. There is no unlock command.

**Participants** never have a password. They receive a single-use link that
opens their screening (`/apply`) or their expert portal (`/portal`). In this
pilot the operator copies that link from the simulated outbox and passes it to
the person directly — by whatever channel you already use.

The links expire, are single-use, and carry the token in the URL fragment so it
is not written to a server log. A forwarded link that has already been opened
does not work, which is the intended behaviour and worth telling participants so
they do not think it is broken.

---

## The one project, end to end

Each step is a screen. The walkthrough in the README has the detail; this is the
order and who does what.

| # | Step | Who | Screen |
| --- | --- | --- | --- |
| 1 | Author and publish a screening rubric | Admin | `/rubrics` |
| 2 | Open a sourcing campaign for the shortage | Operator | `/campaigns` |
| 3 | Add candidates | Operator | `/candidates` |
| 4 | Send a screening, hand over the link | Operator | candidate page → `/outbox` |
| 5 | Candidate reads the brief and submits | Participant | `/apply` |
| 6 | Review against the rubric; request a revision | Operator | `/screenings` |
| 7 | Candidate revises and resubmits | Participant | `/apply` |
| 8 | Qualify | Admin | `/screenings` |
| 9 | Record the new expert's skills | Operator | `/experts/…` |
| 10 | Create the project, run matching, invite | Operator | `/projects` |
| 11 | Expert accepts, completes onboarding | Participant | `/portal` |
| 12 | Verify the onboarding submission | Operator | `/onboarding` |
| 13 | Expert declares availability | Participant | `/portal` |
| 14 | Propose and confirm the seat | Operator | project page |
| 15 | Assign work | Operator | `/work` |
| 16 | Expert submits work | Participant | `/portal` |
| 17 | Review and approve, setting the authorised quantity | Operator | `/work` |
| 18 | Batch, approve, export payment preparation | Two operators | `/payments` |

Step 18 needs two different people: a batch cannot be approved by whoever
created it. **Exported is not paid.** The export is a CSV for a finance process
that lives outside this system, and nothing here moves money.

Expect step 4 to feel wrong — copying a link by hand is the part a real
deployment replaces with email. Note how much friction it adds; that is one of
the things the pilot is measuring.

---

## Monitoring

**Every morning, one person opens `/attention`.** If automation is stalled the
banner is at the top, ahead of the queue. Then `/jobs` for detail.

| What | Where | What it means |
| --- | --- | --- |
| "Automation is not running" | `/attention`, `/jobs` | The worker is down. Nothing is being sent or swept. Restart it |
| Overdue jobs, worker alive | `/jobs` | Something is failing repeatedly. Check the failed jobs table |
| Jobs marked DEAD | `/jobs` | Retries exhausted. That work has not happened. Fix the cause, retry from the table |
| Claims past their lease | `/jobs` | A worker died mid-job. Recovered automatically unless the count keeps climbing |
| Blocking support requests | `/support` | Somebody is stuck and cannot start |

Nothing pages anybody. These are seen by a person who looks, which is why the
watcher and their hours are named before day one.

### Support

Participants raise support requests in their portal; operators answer at
`/support`. Reply and internal note are different buttons — an internal note is
never shown to the participant. One named operator owns support for the pilot
and answers within the working day.

---

## Pausing

| To stop | Do | Effect |
| --- | --- | --- |
| Everything automated | Stop the worker (Ctrl-C) | Nothing sends, expires or sweeps. Queued work waits and runs when it returns |
| One scheduled sweep | `/jobs` → schedules → disable | That one stops; the rest continue |
| Bulk outreach | Do not approve the batch | Dispatch requires a human approval |
| One invitation | Withdraw it on the project screen | |

Stopping the worker is safe and reversible, and is the right first move if
something is behaving oddly.

---

## Backups and incidents

**Daily, and before anything risky:**

```bash
./scripts/backup.sh backups/pilot-$(date -u +%Y%m%d)
./scripts/restore-check.sh backups/pilot-<stamp>.dump
```

Run the check at least once a week. A backup nobody has restored is a
hypothesis.

**If data is lost or corrupted:** stop both processes, restore the most recent
backup into a *new* database with `--keep`, confirm the counts, point
`DATABASE_URL` at it, restart, and only then retire the old database by renaming
it. Full procedure in [`operations.md`](operations.md).

**If something is wrong and you do not know what:** stop the worker first. It
halts all automation without losing queued work, and buys time to look.

**Record every incident**, however small, with what happened, what was visible
on screen, and what was done. That record is the most useful evidence the pilot
produces.

---

## Deciding whether the pilot succeeded

Agree these before starting. Counting them afterwards invites choosing the ones
that look good.

**Did the work get done?**
- One project staffed end to end, from application to approved work to an
  exported payment file.
- Every human decision gate — qualification, verification, staffing, work
  approval, payment approval — exercised by a real operator making a real call.

**Did it help?**
- Operator judgement, written down at the end of each week: what was faster,
  what was slower, what they worked around.
- Count the workarounds. A workaround is a requirement nobody wrote down.

**Was it dependable?**
- Incidents, with cause and time to notice.
- How long the worker was down without anybody noticing. This is the number that
  says most about whether the warnings are good enough.
- Jobs that reached DEAD, and whether anyone spotted them.

**Was it honest?**
- Anywhere the system implied something it had not done. The simulated-email
  labelling exists because "sent" is believed by default; if anybody still
  believed a participant had been emailed, that is a finding.

**Stop the pilot if:** data is lost and not recoverable from a backup; a
participant sees another participant's data; or an operator cannot tell whether
automation is running.

---

## Before a pilot with real participants

None of these work today. Do not assume any of them until it is connected and
tested.

| Needed | Why | Status |
| --- | --- | --- |
| Hosting with TLS, and a supervised worker | Everything else is downstream | Not started |
| A mail provider and sending domain | Participants are unreachable without it; every claim about deliverability is untested | Not started |
| Bounce and complaint handling | A bounced invitation currently looks identical to a delivered one | Not started |
| Account recovery | Needs email first | Not started |
| Lawful basis, privacy notice, retention and deletion | Real people. Deletion conflicts with append-only audit history and needs a decision, not just code | Not started |
| Off-machine backups on a schedule | Backups are manual and local | Scripts exist, schedule does not |
| Alerting | Warnings are visible to whoever looks | Not started |

The smallest step that unblocks the rest is hosting: a single host with TLS,
PostgreSQL with its own backups, and the worker under a supervisor. Email is
second, and is the one that decides whether participants can be real.
