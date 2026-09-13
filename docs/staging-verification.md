# Staging verification

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

- Scheduled backups of the managed PostgreSQL, and a restore from one.
- More than one concurrent tester.
- The `Worker` page still tells the reader to start a worker with `npm run
  worker`, which is not how this deployment runs one.

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
