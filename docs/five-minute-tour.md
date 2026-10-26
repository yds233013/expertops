# ExpertOps — a five-minute walkthrough

A demonstration script for the hosted staging environment. Every record in it is
synthetic. Email is simulated, there is no payment execution, and this is an
independent personal project with no affiliation to any employer or product.

Screenshots referenced below are in
[`screenshots/walkthrough/`](screenshots/walkthrough/).

---

## What the system is for

An expert network has to move a person from "someone applied" to "someone is
working and will be paid" without losing track of who decided what. ExpertOps is
the operations layer for that: sourcing and screening, staffing a project,
handling the person who drops out halfway, reviewing delivered work, and
preparing a payment file for a finance process that lives somewhere else.

The design rule throughout: **the system assembles, a person decides.** Anything
that contacts a human, commits a seat, or touches money waits for an operator.
Everything else runs on a background worker so the operator sees a queue of
decisions rather than a list of chores.

---

## 1. Screening — deciding who is good enough (≈45s)

*The problem:* applications arrive faster than anyone can assess them, and
"we assessed them" has to still be explainable months later.

A screening is judged against a **published rubric version**. Published versions
never change, so a decision made in June is still readable in December against
the rubric it was actually scored on. Two reviewers who disagree raise a
conflict, and the system never breaks the tie — a human does.

**Automatic:** invitations go out, reminders fire, expiries close the window.
**Human:** authoring and publishing the rubric, every score, resolving a
conflict, and the final qualification decision that turns a candidate into an
expert.

> The staging instance carries no screening records, so these screens are empty
> there. The path is exercised end to end by the browser journey suite
> (`tests/e2e/journey.spec.ts`, steps 1–7), which authors a rubric, invites a
> candidate, scores a submission, requests a revision, and qualifies them.

---

## 2. Staffing a project (≈90s)

Open `PRJ-0001`. **Screenshot 03.**

*The problem:* a project needs two people with a particular skill, inside a rate
ceiling, who are actually available and have cleared onboarding.

Matching scores the network and shows its working: `skills 55 · seniority 15 ·
rate 12 · availability 10 · standing 8`. Anyone excluded by a hard filter is
listed with the reason, so the ranking never silently omits someone.

From the ranking an operator assembles an **outreach batch**. This is the part
worth pausing on. **Screenshot 04.** Assembling sends nothing. The batch sits in
`pending approval` until a named operator approves it, and dispatch is a third,
separate action. Provenance is recorded for all three.

The expert then acts in their own portal. **Screenshot 05.** They see their
profile, the invitation, their availability, and their onboarding checklist, and
nothing about anyone else. They accept, declare availability, and submit the
checklist.

An operator verifies the submission. Only then does the seat become proposable,
and a proposal still has to be confirmed.

**Automatic:** scoring, the project advancing `DRAFT → MATCHING → INVITING →
STAFFING → ACTIVE`, rendering and "delivering" each simulated message.
**Human:** approving the batch, dispatching it, verifying onboarding, proposing
and confirming the seat.

---

## 3. Withdrawal and replacement (≈75s)

*The problem:* someone leaves mid-engagement. The seat has to reopen, the work
has to be dealt with, and somebody has to be found — without anyone remembering
to do all of that by hand.

In the portal the expert clicks **Withdraw from this project**. The confirmation
tells them exactly what will happen, including that work they already submitted
is kept along with any payment prepared for it.

One request, and inside a single transaction: the seat is released, the seat
count recomputed, the project drops back to `STAFFING`, the invitation is marked
withdrawn, outstanding work is cancelled, stale attention items are resolved,
and a replacement search is queued.

**Screenshot 02** is the operator's side of that: a queue that says what is
blocked, what the impact is, and what to do next. Items appear and disappear on
their own as conditions change.

The worker then drafts a replacement batch — and it is only a draft. It proposes
neither the person who just withdrew nor anyone already assigned. An operator
approves and dispatches it exactly as before.

**Automatic:** everything in that transaction, plus drafting the replacement
batch and raising the attention item.
**Human:** approving and dispatching the replacement outreach, and confirming
the new seat.

---

## 4. Work review (≈60s)

**Screenshot 06.** An operator assigns a work item to a confirmed seat: title,
instructions, basis (hourly or deliverable), and a due date. The due date is not
decoration — the overdue sweep selects on it, so an item without one is never
reported late.

The expert submits from their portal with a summary, what they did, and hours
claimed. The operator reviews against that submission and approves, or requests a
revision with a written reason. Approving sets the quantity that payment
preparation will read; approving fewer hours than claimed is allowed and flags
the resulting payment item for an explanation.

A review judges one submission. It never changes the expert's standing in the
network — that is a separate decision with its own record.

**Automatic:** overdue detection, the attention item when work is waiting on a
reviewer, drafting the payment item on approval.
**Human:** writing the assignment, the review itself, and the approved quantity.

---

## 5. Payment preparation (≈60s)

**Screenshot 07.** The heading is the point: *"Prepares an approved file for a
finance process that lives elsewhere. Nothing here moves money, and exported is
not paid. There is deliberately no action that marks an expert as paid."*

Approved work becomes a draft payment item. An item whose figures differ from
what was claimed is held until someone records why. Cleared items are gathered
into a batch, and **a batch must be approved by someone other than the operator
who created it** — the server refuses self-approval, not just the button.

Export produces a CSV for the finance process. The batch is then marked
`exported`, badged "not paid", with the line "This records that a file was
produced, not that anyone was paid."

**Automatic:** drafting the item and flagging discrepancies.
**Human:** the explanation, creating the batch, the second-person approval, and
the export.

---

## 6. The spine underneath (≈30s)

**Screenshot 08** is the activity history filtered to the background worker.
**Screenshot 09** is the worker itself.

Every action is attributed to a human operator, an expert in their portal, or the
worker, and the history is append-only. Jobs and schedules live in PostgreSQL and
are claimed with `FOR UPDATE SKIP LOCKED`, so several workers can run at once and
a restart never loses or repeats work. The worker page answers the one question a
job list cannot: a quiet queue and a dead worker look identical, and this says
which it is.

**Screenshot 01**, the dashboard, is where a demo can start or end: pipeline
state, network composition, and whether automation is actually running.

---

## What to say about limits, unprompted

- Email is **simulated**. Messages are rendered and stored in an in-app outbox
  and marked delivered by the worker. No mail transport is configured and no code
  opens a connection to one.
- There is **no payment execution**. The system prepares a file. Nothing in it
  moves money and no action marks anyone as paid.
- It is a **staging environment with synthetic data**, behind an HTTP Basic gate,
  not a production service.
- This is an **independent project**. It is not affiliated with, endorsed by, or
  derived from any employer or commercial product.
- No claim is made about time saved, adoption, or production readiness. What is
  verified is written up in
  [`staging-verification.md`](staging-verification.md), including what is not.

---

## Screenshot index

All captured on the hosted staging deployment, signed in as a synthetic operator
so no personal email address appears. Each was reviewed before being committed;
none contains a password, token, portal link or credential dialog.

| # | File | Shows |
| --- | --- | --- |
| 01 | `01-operator-dashboard.jpg` | Pipeline state, network composition, worker health |
| 02 | `02-needs-attention.jpg` | The queue of things blocked on a person |
| 03 | `03-project-matching-and-seats.jpg` | Seats, brief, and the scored ranking with its working shown |
| 04 | `04-outreach-batch-approval.jpg` | Assemble, approve and dispatch as three separate acts |
| 05 | `05-expert-portal.jpg` | The expert's own view: invitations, availability, checklist |
| 06 | `06-delivery-work-items.jpg` | Assigning work with a due date, and a submission under review |
| 07 | `07-payment-preparation.jpg` | An approved, exported batch badged "not paid" |
| 08 | `08-activity-worker-only.jpg` | Append-only history filtered to the background worker |
| 09 | `09-background-worker.jpg` | Whether automation is actually running |
