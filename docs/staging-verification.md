# Staging verification

> **Names in this record are as they were at the time.** On 16 September 2026
> migration `20260916100000_fixture_display_names` gave seeded fixtures natural
> display names — `PRACTICE coding review pilot` became `Coding review pilot`,
> `NET <name> 0NN` became a new, unique plain name derived from the serial — and
> appended a `fixture.renamed`
> activity event for each change. IDs, references and emails did not change.
> Operator accounts (such as `SYNTHETIC Approver`) and records created through
> the browser (such as `HOSTED APPLICANT Vela Ashworth`) were not renamed.


Two runs against the hosted deployment at
`https://web-production-09e7e.up.railway.app`, on 13 September 2026. The first
drove the REST API directly; the second drove the browser. Every record is
synthetic, no message left the machine, and no money moved.

The tester gate stayed on throughout both runs.

---

## Run 2 — through the browser

The whole run was clicks and keystrokes on real pages, as an operator in one tab
and as an expert in another. Four defects surfaced. All four are fixed and
deployed; each has a regression test that fails against the code that shipped
before it.

### Work assigned, submitted, reviewed, paid out on paper

| Step | Result |
| --- | --- |
| Two work items assigned through Delivery, with instructions and due dates | WRK-0001 to Avery Lindqvist due 24 Dec 2026, WRK-0002 to Dara Nkemelu due 28 Nov 2026 |
| The two "staffed with no work assigned" attention items | Resolved on their own as each item was created. Neither was dismissed by hand |
| Expert submits WRK-0001 from the portal | Revision 1, 7 hours claimed |
| Operator reviews and approves | Approved at 7 hours, with structured feedback |
| Payment preparation | PAY-0001, 7 × $180 = $1260.00 USD, ready to batch |

Nothing was exported and no batch was created. The page states its own limits:
"Nothing here moves money, and exported is not paid."

### One full lifecycle

Invitation → onboarding → assignment → withdrawal → approved replacement, all in
the browser.

1. Cleo Marchetti opened an outstanding invitation and accepted it.
2. She completed the six-item onboarding checklist and submitted it.
3. An operator verified her from the Verification queue.
4. She declared availability; the operator proposed and confirmed the seat.
   PRJ-0001 reached ACTIVE at 2 of 2.
5. She withdrew from her own portal. The seat released, the project returned to
   STAFFING at 1 of 2, and the attention queue raised the withdrawal.
6. An operator assembled outreach batch BAT-0003, submitted it, approved it, and
   dispatched it — three separate, explicit steps.
7. Bo Okonkwo accepted the replacement invitation and was proposed and
   confirmed. PRJ-0001 is ACTIVE at 2 of 2.

### Access control

Signed out through the header control. `/experts`, `/payments` and `/outbox`
each redirected to `/login`. The expert portal session in the other tab was
unaffected, which is the point of the two cookies being separate. The operator
session was then restored.

### Every navigation page

All sixteen load with no error: Needs attention, Dashboard, Candidates,
Campaigns, Screening, Rubrics, Projects, Outreach, Experts, Verification,
Delivery, Support, Payments, Outbox, Activity, Worker. The worker page reported
one live worker, 1226 jobs succeeded, none failed or dead.

---

## What the browser run found

**Work items could never be reported overdue.** `work.remind_overdue` selects on
`dueAt <= now`, and the assign-work form neither offered a due date nor sent one.
Every work item an operator created was invisible to that sweep — while the
attention item for an idle seat told the operator to "create a work item with
instructions and a due date", which was advice they could not follow.

**Every screen claimed to be a local development build.** The footer of all
three layouts, and the signature on every simulated message, said "local
development build" on a hosted box. That is the one sentence a tester reads to
decide whether what they are looking at is real, and it was wrong in the
direction that makes someone dismiss a genuine problem as a local artefact.

**An expert who lost their portal link could not be given another.**
`/portal/enter` tells them to ask their ExpertOps contact for a new one. Portal
links are single-use and only invitations and onboarding nudges ever issued one,
so the contact had no way to answer — and a staging environment stopped being
usable the moment its first link was opened.

**A withdrawal left the project ACTIVE holding an empty seat.** Observed live:
an expert withdrew, the project dropped to 1 of 2, and it stayed ACTIVE with the
attention item reading "0 seat(s) now unfilled" directly above a projects list
saying 1/2. An ACTIVE project accepts no invitations, and the operator UI offers
no way back from ACTIVE, so the seat could not be refilled at all. The cause was
`computeProjectGap` counting an unanswered invitation as covering the seat.

**Re-inviting somebody crashed the second batch's dispatch.** Assembling a
replacement batch containing an expert invited to this project before failed
with a raw Prisma error on the operator's screen, and marked the recipient
"retryable" when no number of retries could succeed.
`OutreachBatchItem.invitationId` was unique, but invitations are reopened rather
than replaced, so the same id comes back every later time.

---

## Still not verified

- **Hosted backup availability and recovery remain unverified.** See
  [Recovery](#recovery-what-is-known-and-what-is-not) below.
- **Concurrent-tester behaviour on the hosted instance.** Race safety is
  evidenced locally against real PostgreSQL, not on the deployment. See
  [Concurrency](#concurrency-local-evidence-not-hosted).
- The `Worker` page still tells the reader to start a worker with `npm run
  worker`, which is not how this deployment runs one.

---

## Recovery: what is known, and what is not

Inspected on the hosted deployment, 13 September 2026.

**Hosted backup availability and recovery remain unverified.**

What was observed: Railway's point-in-time recovery for this Postgres service
reports `Status: disabled`, `Bucket wired: no`. Enabling it is a paid change and
has not been made. The service has a 221 MB volume, which is storage rather than
a backup — it survives the container being replaced, not the data being
corrupted.

What was not established: whether the platform keeps any backup of its own
outside the PITR feature. Nothing available here can confirm or rule that out,
so no claim is made either way.

**A manual hosted backup cannot be taken with existing access.** Every route into
that database requires a change that was deliberately not made:

| Route | Why not |
| --- | --- |
| `railway ssh` / `railway service files` | Refused: no SSH key registered. Registering one is an account-level change |
| `railway connect` (psql) | Same SSH requirement |
| Public TCP proxy on Postgres | Would expose the database to the internet, against the security posture this environment is built around |
| Enable PITR | A paid resource |

So hosted backup availability and recovery remain unverified, and that is the
most important open item in this environment.

**Restore mechanics are verified, locally.** `tests/integration/backup-restore.test.ts`
runs against real PostgreSQL and covers the things a restore has to get right —
business records, audit history and queued work arriving intact in a fresh
database, and a corrupted dump being refused rather than half-restored. Re-run
during this pass: passed. No worker was started against any restored copy.

This is evidence that the restore path works. It is **not** evidence that the
hosted data can be recovered, because no hosted backup exists to recover from.

---

## Concurrency: local evidence, not hosted

**Session separation, on the deployment.** Two authenticated contexts were open
side by side in the browser: an operator session and an expert portal session,
each rendering its own identity, neither leaking into the other. The two use
separate cookies by design. Full cross-context isolation with independent cookie
jars is exercised by the browser suite, which gives the operator, the candidate
and the expert their own contexts.

**The bounded seat race, locally.** `tests/integration/concurrency.test.ts`
covers it directly against real PostgreSQL, and was re-run during this pass:

- the last seat under two simultaneous confirmations goes to exactly one
- many confirmations racing for a few seats never oversubscribe
- exactly one confirmation event is recorded per successful seat
- confirming the same assignment twice at once succeeds once

**This is local verification and is not claimed as hosted verification.** No load
test was run and no uncontrolled retries were issued.

---

## Payment batch: the second approver

The gap left open above is now closed. A second operator account was added with
`scripts/create-operator.ts`, role ADMIN, which is the role carrying
`payment:approve`. Its password was generated locally and passed to the script
through an environment variable, so the script's print-once branch never ran; the
variable was deleted from the service afterwards and the value is not in this
repository or in any log.

**This exercised two account identities, not two independent human approvers.**
One person drove both sessions. What it proves is that the application binds
approval to an identity other than the creator's and records both. It says
nothing about whether a second human actually reviewed the figures, which is the
control the rule exists to provide.

| Step | Actor | Result |
| --- | --- | --- |
| Create batch from PAY-0001 | Yash Shah | PB-0001, 1 item, 1260.00 USD, 01–13 Sept 2026 |
| Submit for approval | Yash Shah | pending approval |
| Approve as the creator | Yash Shah | **Refused**: "A payment batch must be approved by someone other than the operator who created it." Batch stayed pending |
| Approve | SYNTHETIC Approver | approved |
| Export CSV | SYNTHETIC Approver | exported |

The exported file, `pb-0001.csv`: one header row and exactly one data row,
`PAY-0001` appearing once, amount `1260.00` USD, consistent with 7 hours at
180.00. No column or value in the file records payment — there is no `paid`,
`settled` or `paid_at` field anywhere in it.

Export did not mark anything paid. The page reports the batch as `exported` and
badges the count "not paid", with the line "Exported. This records that a file
was produced, not that anyone was paid." The activity log names all three acts
separately: created by Yash Shah, approved by SYNTHETIC Approver, exported by
SYNTHETIC Approver.

The tester gate stayed on throughout: `/` and `/payments` both answered 401 to an
unauthenticated request during the run.

One thing worth changing, not changed here: the Approve button is offered to the
batch's own creator, and the refusal only arrives after clicking it. The server
is right and the button is wrong.

---

## Run 1 — through the REST API

An earlier pass over the same lifecycle, driven with `curl` against the routes
the browser UI calls, with the gate enforced, a real operator session and a real
CSRF token on every mutation. It covered invitation, onboarding, staffing,
withdrawal and replacement, and confirmed that the replacement batch proposes
neither the expert who withdrew nor the one still assigned.

It went that way because the outer gate is HTTP Basic authentication, and the
browser automation available at the time refused credentials embedded in a URL
while a native credential dialog blocked it outright. Lifting the gate for the
duration was the alternative and was rejected. Run 2 became possible once the
browser held the gate credentials already.

**A note carried over from run 1:** portal links are readable in the outbox
whatever `EXPOSE_PORTAL_LINKS_IN_UI` is set to, because the invitation template
writes the link into `bodyText` and the outbox renders it. It is how both runs
reached the portal, and on a box with simulated email it may be the only way a
tester ever could — but anyone with `outbox:read` can take over any expert's
session. Unchanged, and worth a deliberate decision.

---

## The hundred-contributor exercise

Run 14–15 September 2026. Full description in
[`network-exercise.md`](network-exercise.md).

### Where each part actually ran

Both environments ran the **same seeding script**, and that script performs the
whole operational cycle rather than just creating records. So both have a fully
staffed network. What separates them is the browser work.

| | What ran there |
| --- | --- |
| **Locally**, against `expertops_exercise` | The scripted exercise **and** the browser work: the candidate journey end to end, the scale checks, and the payment chain driven through the interface by two account identities. |
| **Hosted staging** | The scripted exercise only, through the worker's pre-deploy command — this deployment has no shell. No browser journey ran there, which is why it has **0 applications**. |

An earlier version of this report called the hosted run "setup only" and listed
its operational numbers as unverified. That was wrong, and it was wrong because
nobody had looked: the session had expired and the numbers were never read. They
have now been read in the interface, and they are below.

### Hosted staging, verified in the browser on 15 September 2026

| | |
| --- | --- |
| Projects | **5.** Three belong to the exercise — PRJ-0003 12/12, PRJ-0004 10/10, PRJ-0005 8/8, all `active`. The other two predate it: PRJ-0001 (2/2, active) and PRJ-0002 (0/2, draft). |
| Seats | **30 of 30** across the three exercise projects |
| Experts | **108.** 100 seeded, 8 predating the exercise. By state: 46 verified, 53 prospect, 9 onboarding |
| Pagination | "50 of 108 experts", `Next 50` reaching the second page and `Back to the start` returning |
| Contact preference | "Not asked yet" on a seeded record **and** on one created long before the field existed. Nothing was inferred from anyone's notes |
| Opportunities | 3 published, 0 draft, 0 closed, **0 applications** |
| Outreach | 8 batches, 5 of them the exercise's, all dispatched, all created by Exercise Coordinator |
| Payments | 4 items exported, 0 ready, 0 flagged. PB-0002 — $3,939.00, 3 items, created by Exercise Coordinator, **approved by Exercise Approver**. PB-0001 from the earlier verification is untouched |
| Worker | 1 reporting, heartbeat current, 2,877 ticks, 17,105 succeeded, **0 failed, 0 dead** |
| Migrations | 12 found, all applied |
| Basic gate | `401` on `/dashboard`, `/experts` and `/apply/opportunities` without credentials |

Every exercise action on staging is attributed in the audit history to the
synthetic exercise identities, not to a real person's account.

### Contributor counts by state — local

| | Count |
| --- | --- |
| **Total** | **105** — 100 seeded, 5 who came through `/apply/opportunities` in a browser |
| Applications | 7, every one from the applicant pages. None from a seeded expert |
| Contact preference | `UNKNOWN` for all 105. Nothing inferred from the notes the seeder wrote |

The local browser journey runs once per suite execution and leaves one applicant
behind each time, which is why the applicant count grows while the seeded 100
does not.

### Current states versus cumulative events

These are different numbers and were previously run together. A count of rows in
a status is what is true now; a count of activity events is what happened at any
point, including to records that have since moved on.

| Current state (rows, now) | Cumulative events (history, ever) |
| --- | --- |
| Invitations: 53 accepted, 9 declined, 2 withdrawn | 55 acceptances, 9 declines |
| Assignments: **30 confirmed**, 4 released | 36 confirmations, 6 releases, 2 expert withdrawals |

The gaps are real history, not drift: two acceptances belong to invitations later
withdrawn, and six confirmations were followed by a release — two of them expert
withdrawals during the exercise, the rest seats released and refilled by the
browser journey on each run.

| | |
| --- | --- |
| Seats confirmed | **30 of 30**, across the three exercise projects |
| Qualifications | 24 |
| Outreach batches | 5, each approved by an account other than its creator |
| Payment batches | 7, one exported through the browser by a second identity |
| Open attention items | 40, each naming a blocker, an impact and a next action |
| Jobs processed | 494, **0 dead** |
| Simulated outbox messages | 149. No mail server is configured |

The 100 seeded experts did **not** apply to anything. Applications only arrive
through `/apply/opportunities`, and the two are counted separately.

### What ran through a browser, and what did not

| Through a browser, locally | Through services, in a script |
| --- | --- |
| The whole candidate journey: listing, application, operator review, screening, revision request, resubmission, qualification, profile, invitation, acceptance, onboarding, verification, confirmed seat | Seeding the 100, matching, outreach approval and dispatch, invitation responses, onboarding of the 30, verification, seat confirmation, two withdrawals, replacement and restaffing |
| Search, status filters, paging, project capacity, the attention queue, outreach batch counts, worker health | |
| Work assignment, submission from the expert portal, review at reduced hours, discrepancy explanation, batching, refused self-approval, approval by a second account, CSV export | The same chain once at service level |

Every script call goes through the same service function the interface calls, so
capability checks, state-machine guards and audit entries apply identically.
Nothing writes a business status directly.

### The 24 scripted qualifications were synthetic decisions, not reviews

Each one followed the real code path — a candidate, a screening against a
published rubric version, a reviewer, a recorded decision — and each is attributed
in the audit history to the operator identity that executed it.

Nobody read them. The answers were generated by the seeding script and approved
by the same script under an operator identity, in a single unattended run. They
are **synthetic decisions executed under an operator identity**, and they are
evidence that the qualification path works end to end. They are not evidence that
anybody exercised judgement, and no claim about review quality rests on them.

The one qualification made in the browser during the candidate journey is the same
in kind: one person driving a test, not an independent reviewer.

### Two account identities, not two people

The application refuses to let the account that created a payment batch approve
it. That refusal was exercised in the browser by an ADMIN who could see the
button; the batch stayed pending, and a different ADMIN approved it.

This is separation between **account identities**. One person drove both
sessions. It is not independent human approval and is not evidence of it.

### Nothing was paid

Exporting marks the batch and its items `EXPORTED`. There is no `PAID` state in
the schema, no column in the CSV that could record a payment, and no action in
the application that moves money.

### The hosted candidate journey, 15 September 2026

Run in the browser against staging, with an applicant who has no account and an
operator signed in as SYNTHETIC Approver. Separate sessions: the applicant holds
`expertops_candidate`, the operator `expertops_session`, and the two never mix.

**New records, all clearly synthetic and all from this run:**

| Record | |
| --- | --- |
| `APP-0001` | Application from HOSTED APPLICANT Vela Ashworth (`hosted.applicant.vela@example.test`) |
| `CAN-0022` | The candidate record the application created |
| `SCR-0022` | Screening against PRACTICE coding screening v1 |
| — | Two screening submissions and one simulated outbox message |

Nothing else was touched. The 100 seeded experts and the 8 that predate them are
unchanged, all three exercise projects remain at 12/12, 10/10 and 8/8, and no
seat was released or added.

**What was verified:**

| | |
| --- | --- |
| Filed under the right opportunity | OPP-0001 shows 1 application; OPP-0002 and OPP-0003 still show 0 |
| Submission preserved against a snapshot | The applicant page records it "as it read on 15 Sept 2026, 02:06 UTC" |
| Screening sent from the application | `SCR-0022`, and the panel then showed the open screening rather than offering a second |
| Candidate isolation | `/apply` shows their own application and says so. No other applicant's name appears |
| Revision requested | Scores 3/5 and 2/5, public feedback, decision note. Attributed to **SYNTHETIC Approver: REQUEST_REVISION** |
| **Private note stays operator-only** | A canary string was written into "Private notes, never shown to the candidate". It appears **nowhere** in the HTML the candidate receives — checked against the whole document, not just the visible text, so a hidden element or an embedded payload would have been caught. The public feedback and the decision note are both present, as intended |
| Resubmission | Revision 2 recorded complete, Revision 1 preserved beside it, status back to `submitted` |

**Qualification, completed 15 September 2026.** The review of revision 2 scored
4 and 4 against PRACTICE coding screening v1 — a specific decision on a named
changeset, and a clear account of what they chose not to do and why — recorded as
`SYNTHETIC Approver: APPROVE`, then qualified with a decision note. Both halves
say in writing that this is a synthetic decision by a test identity, that no
references were taken, and that nobody independent reviewed it.

**What qualification did, and did not, do:**

| | |
| --- | --- |
| Experts | **108 → 109.** Exactly one record created: `EXP-0109`. Verified counts by state — prospect 53 → 54, verified 46 unchanged, onboarding 9 unchanged |
| Status of the new expert | `prospect`, 0 years, $0/h, no skills. The conversion carries a name, an email and a headline and nothing else |
| Invitations | **None.** The record reads "No invitations yet" |
| Assignments | **None.** "Not staffed on any project" |
| Availability | None declared |
| Onboarding | Not started |
| History on the new expert | Exactly two events — `expert.created` and `qualification.granted`, both attributed to SYNTHETIC Approver |
| Exercise projects | **Unchanged: 12/12, 10/10, 8/8**, all `active`. No seat released, no headcount raised |

Qualifying makes somebody eligible. It does not staff them, and on staging it
demonstrably did not: onboarding verification, an accepted invitation and
declared availability are all still missing, which is exactly what the screen
says when you press the button.

**The private notes stayed operator-only across both decisions.** A distinct
canary went into the revision review and another into the approval. Neither
appears anywhere in the HTML the candidate receives — the whole document was
searched, not the visible text. What the candidate does see is the public
feedback on both reviews, the revision decision note, and "A decision has been
recorded on this screening."

**On the 503s reported earlier:** they were transient and were not a credential
problem. The same tab later loaded every page normally with no intervention, and
at the time the failure was visible at the network layer as a 503 on every
request from that tab — including `/login` — while a shell request carrying the
gate credentials got 200. A gate refusal would have been a 401. The cause was not
established; it did not recur.

### Opening the deployment for review, 15 September 2026

The HTTP Basic gate is off. It was one shared password in an environment
variable: a perimeter, not an authorisation model, and it made the deployment
unreviewable without handing that password out. It came off only after the
application's own boundaries were tested, and the module and its 11 unit tests
remain in the tree so the gate can be switched back on by setting the two
variables again.

**What is public now**

| | |
| --- | --- |
| `/demo` | Read-only synthetic overview |
| `/apply/opportunities` and each listing | Practice listings and the application form |
| `/apply/enter`, `/portal/enter` | Magic-link landings. They carry no data; the token is in the fragment |
| `/login` | Sign-in, throttled at 8 failures per address and 30 per client in 15 minutes |
| `/api/health` | Status and three counts |

Everything else refuses an anonymous request.

**Verified on the hosted deployment, with no credentials at all**

| Check | Result |
| --- | --- |
| Public surfaces | 5/5 return `200` |
| Operator pages — dashboard, experts, candidates, projects, opportunities, screenings, outbox, activity, payments, jobs, attention | 11/11 return `307` to sign-in |
| Administrative read APIs | 12/12 return `401` |
| Anonymous mutations | 6/6 return `401` |
| `WWW-Authenticate` challenge on any path | None — the gate is genuinely gone, not merely bypassed |
| `/apply` and `/portal` without a session | `200` with "Your session has ended". No candidate record, reference or address in the response |

**The demo leaks nothing.** The hosted `/demo` HTML was searched for portal
links, session cookie names, `@example.test` addresses, password hashes and
candidate, application, screening and payment references. All absent. The only
match for "Internal notes" is the demo's own list of what it does not show.

The demo is a separate projection in `src/server/services/demo.ts`, not the
VIEWER role with permissions turned down — VIEWER carries `outbox:read`, which
is single-use sign-in links. It reads whitelisted records (synthetic name
prefixes only) and whitelisted columns.

That whitelist is visible in the numbers: the demo reports **108 experts** while
`/api/health` reports **109**. The difference is `EXP-0109`, created by the
hosted candidate journey. It carries no synthetic prefix, so the demo cannot see
it — which is the rule working rather than a discrepancy.

**Two fixes the boundary tests found**

- `/dashboard` was the only operator page relying solely on the layout's
  redirect. A layout is not an authorisation boundary; it now guards itself.
- `POST /api/rubrics` and `POST /api/screenings/[id]` parsed the request body
  before authenticating, because the capability depends on the action. Nothing
  was written without the check, but an anonymous caller received a
  schema-validation error rather than a refusal. Both authenticate first now.

**A hands-on practice board, separate from the exercise**

`PRJ-0006 PRACTICE hands-on review pilot` — one seat, empty, `matching`, requires
Code Review at 3/5 and one year. Listed as `OPP-0004 PRACTICE hands-on code
reviewer`. Created by `scripts/practice-hands-on.ts`, which is idempotent.

No seat was released from the exercise to make room. The demo's "Seats
confirmed" tile reads **32** — the 30 exercise seats, plus 2 on the pre-existing
`PRJ-0001`, plus 0 on the new one.

### Still unverified

- Hosted backup availability and recovery.
- Concurrent-tester behaviour. This exercise is **100 managed records**, not 100
  concurrent users; no load was generated.
- ~~Every hosted operational number.~~ **Now verified** — see the hosted table
  above. Read in the interface on 15 September 2026.
- The hosted candidate journey is now complete end to end, including
  qualification. What has *not* been exercised on staging is what comes after:
  the new expert has no profile, no skills, no invitation and no seat, so
  onboarding, verification and staffing from an application remain local-only.
