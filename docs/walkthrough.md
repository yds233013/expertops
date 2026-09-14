# Hands-on operational walkthrough

A guided run through ExpertOps on your own machine, using synthetic data only.
Every instruction below names a control that exists on the screen. Where a step
is done by the worker rather than by you, it says so.

This walkthrough was corrected after the expert-initiated withdrawal journey was
built. The withdrawal and replacement sequence in
[Flow F](#flow-f--an-expert-withdraws-and-a-replacement-is-staffed) is the part
that changed: a replacement now goes through invitation, acceptance,
availability, onboarding and operator verification before a seat is confirmed,
and only then can work be assigned. The same sequence is covered end to end by
`tests/e2e/withdrawal.spec.ts`, and [`flow-f-run.md`](flow-f-run.md) records what
happened when a person walked Flow F by hand, including the two defects it
found.

---

## Finding your way

The sections live in a sidebar on a wide screen, and behind a **Menu** button on
a narrow one. They are grouped in the order work moves through the system:

| Group | Sections |
| --- | --- |
| **Today** | Needs attention, Dashboard |
| **Sourcing** | Candidates, Campaigns, Screening, Rubrics |
| **Staffing** | Projects, Outreach, Experts, Verification |
| **Delivery** | Work, Support, Payments |
| **System** | Outbox, Activity, Worker |

A number beside a section is work waiting on a person, not a record count. When
this guide says *Work*, it means the sidebar item under **Delivery**; the page
itself is headed "Delivery".

---

## Who does what

Each step carries one marker.

| Marker | Meaning |
| --- | --- |
| **[Operator]** | You, signed in to the operator workspace. |
| **[Expert]** | A person in the expert portal, in their own browser profile. |
| **[Candidate]** | A person in the application portal, in their own profile. |
| **[Worker]** | The background worker. Nothing to click; wait and reload. |
| **[Simulated]** | A message written to the in-app outbox. No email is sent. |
| **[Payment prep]** | Produces a file and an approval record. Moves no money. |

Two things are never automatic: **verification** and **any approval**. The
worker assembles, drafts, reminds and flags. It never contacts anyone, never
verifies anyone and never approves anything.

---

## Before you start

Three processes, in three terminals.

```
npm run db:up          # PostgreSQL on port 5433
npm run dev            # the app on http://localhost:3000
npm run worker         # the background worker
```

Check all three are up:

```
curl -s http://localhost:3000/api/health
```

The operator workspace is at <http://localhost:3000/dashboard>. Sign in with a
seeded operator; `prisma/seed.ts` lists them. You need two operator identities
for the approval steps, because an approval by the person who asked for it is
refused on purpose.

**Do not run `npm run db:reset` or `npm run db:seed` if you have data you want
to keep.** Both are destructive.

---

## Separate identities, properly

This walkthrough has four identities: two operators, one expert, one candidate.
Each needs its own cookie jar.

**Use a separate Chrome profile per identity** (Chrome → profile icon → *Add*),
or a different browser per identity.

Do not rely on two incognito or private windows. In Chrome, every incognito
window shares one incognito session, so signing in as a second operator in a
second incognito window silently replaces the first. The symptom is confusing:
a page shows the wrong person's name, or an approval you expected to be refused
goes through. If you see that, check which profile the window belongs to before
reporting it.

The expert and candidate portals use their own cookies (`expertops_portal`,
`expertops_candidate`), so an operator session cannot make a portal page look
signed in. That separation is real. The one that is not enforced by the app is
operator-versus-operator, which is why profiles matter.

---

## Flow A — sourcing, screening and qualification

1. **[Operator]** *Rubrics*. Type a name in **Template name**, click **Create
   template**, then **Start draft v1** on the card that appears.
2. **[Operator]** Fill **Instructions shown to the candidate** and **Why this
   version exists**. For each criterion fill **Label** and **What a reviewer
   should look for**, and choose **Required evidence**. **Add criterion** adds
   another. Click **Save draft**.
3. **[Operator]** Click **Publish v1**, then **Confirm: publish v1**. The editor
   is replaced by a read-only view saying *This version is immutable*. A
   published version can never be edited; **Start draft v2** is the only way
   forward.
4. **[Operator]** *Campaigns*. Fill **Campaign name** and **Qualified target**,
   click **Open campaign**, then **Move to active**.
5. **[Operator]** *Candidates*. Fill **Full name**, **Email**, **Headline**,
   pick the **Campaign**, click **Add candidate**. Open the candidate from the
   list.
6. **[Operator]** On the candidate page choose a **Published rubric version**
   and click **Send screening**. A reference like `SCR-0001` appears.
7. **[Worker]** The screening invitation is queued and dispatched.
   **[Simulated]** Read it on *Outbox*: the card shows **Portal link (dev
   only)**, which exists because `EXPOSE_PORTAL_LINKS_IN_UI=true` in
   development. Copy that link.
8. **[Candidate]** In the candidate's own profile, open the link. The page
   greets them by name and shows the instructions and every criterion before
   they answer. Fill the criterion fields and click **Submit responses**.
   If a criterion requires a work sample link and none is given, the answers are
   kept and the page says *Required evidence is missing*.
9. **[Worker]** A reviewer is assigned shortly after submission.
10. **[Operator]** *Screening*. On the candidate's card, score each criterion,
    fill **Feedback the candidate will read** and, if useful, **Private notes,
    never shown to the candidate**. Click **Ask for a revision** or **Recommend
    approve**. If the card shows **Assign a reviewer** instead of a review form,
    the worker has not assigned you; pick yourself and click **Assign**.
11. **[Operator]** Fill **Note explaining the decision**, then **Request a
    revision** or **Qualify**.
12. **[Candidate]** At `/apply` the candidate sees *Requested changes*, the
    decision note and the reviewer feedback. The private note is not on the
    page. Their previous answers are still editable. **Submit revised
    responses**.
13. **[Operator]** *Experts*. Open the newly qualified person. Fill **Skill**
    and **Proficiency** and click **Save skills**. This matters: a qualification
    says someone met a bar, not what they can do, and an expert with no skill on
    file is excluded from every match by a hard filter.

---

## Flow B — a project, matching and an invitation

1. **[Operator]** *Projects* → **New project**. Fill **Title**, **Client**,
   **Seats** and **Min. experience**. Add at least one **Skill name** and set
   **Requirement type** to *optional* or *required*. Click **Create project**.
   An optional requirement weights the ranking; a required one excludes people.
2. **[Operator]** Click **Open for matching**, then **Run matching**. The
   ranking is deterministic and rules-based. The *Matching* card names the
   algorithm version and how many people were considered, ranked and excluded,
   and the excluded list gives a reason for each.
3. **[Operator]** On the row for the person you want, click **Invite**, add an
   optional message, then **Send invitation**. The row shows *sent*.
4. **[Worker]** The invitation message is dispatched to the outbox.
   **[Simulated]** Copy the **Portal link (dev only)** from *Outbox*.

---

## Flow C — onboarding, verification and a confirmed seat

1. **[Expert]** In the expert's own browser profile, open the portal link. The
   portal opens with *Hello, <name>*. Portal links are single-use; a second use
   of the same link fails, which is correct.
2. **[Expert]** Under *Open invitations*, click **Accept**. The onboarding
   checklist opens on the same page.
3. **[Expert]** Under *Your availability*, fill **From**, **To** and
   **Hours/week** and click **Add window**. Leave **For project** on *General*
   unless the availability is specific to one project.
4. **[Expert]** Under *Onboarding checklist*, answer every field and tick every
   attestation, then click **Submit for review**. The panel then reads
   *Submitted and waiting on a human operator*.
5. **[Operator]** *Verification*. The card for that expert shows their checklist
   answers and says **Operator decision required for <name>**. Click **Verify
   expert**, or **Return for changes** with a note. Nothing on this page is
   decided automatically, and the expert cannot be staffed until it is decided.
6. **[Operator]** Back on the project, the *Staffing* table lists the accepted
   expert with their expert status, declared hours and assignment state. If the
   **Action** column shows a blocker rather than a button, that text is the
   reason. Set **h/week** and **Rate USD/h** in that row, then click **Propose
   <first name>**. The row shows the declared availability underneath, and
   proposing more hours than were declared is refused.
7. **[Operator]** Click **Confirm seat**. This is the step that consumes
   capacity. The *Seats* tile moves to `1/1` and reads *full*, and the action
   becomes **Release seat**.

---

## Flow D — delivery and review

1. **[Operator]** *Work* (sidebar, under **Delivery**). Choose the **Staffed seat**, fill **Title**,
   **Instructions** and **Basis** (*Hourly* or *Deliverable*), then click
   **Assign work**. A reference like `WRK-0001` is created.
2. **[Expert]** *Your work* in the portal shows the item. Fill **One-line
   summary**, **What you did**, and **Hours worked** if the item is hourly, then
   click **Submit work**.
3. **[Worker]** A review task is raised for the operators.
4. **[Operator]** *Work* (sidebar, under **Delivery**). On the item, click **Review WRK-…**, fill
   **Summary**, set **Approved hours** (you may approve fewer than were claimed;
   the difference becomes a discrepancy flag rather than a silent adjustment)
   and click **Approve**, or ask for changes with a specific description of what
   to change.
5. **[Expert]** A revision request appears at the top of the item, and the
   previous submission is still there to edit and resubmit.

---

## Flow E — a support request

1. **[Expert]** In the portal, fill **Subject**, **What do you need?** and
   **Category**, then click **Send request**. A reference like `SUP-0001`
   appears.
2. **[Operator]** *Support*. In the thread, fill **Reply to SUP-…**. Tick
   **Internal note: keep this out of the expert's portal** and click **Save
   internal note** for something the expert must never see; leave it unticked
   and click **Send reply** for something they will read. **Resolution** plus
   **Mark resolved** closes the thread, and the note is required.
3. **[Expert]** The reply appears in their thread. The internal note does not.
4. **[Operator]** A request that blocks the expert from working shows a **blocks
   readiness** badge, and the project's *Staffing* table then names it as their
   blocker. Setting that flag has no control on the screen today; it is one of
   the remaining API-only actions. Record it if you need it.

---

## Flow F — an expert withdraws and a replacement is staffed

This is the flow that was previously described incorrectly. The corrected
sequence is below. The replacement is not staffed by approving outreach: they go
through the whole acceptance, availability, onboarding and verification path
first.

### The withdrawal

1. **[Expert]** In the portal, find the card titled **Leaving a project**. It
   lists every current commitment with its project code, title, client, dates
   and stage: *Accepted, not yet given a seat*, *Seat proposed, awaiting
   confirmation* or *Assigned and confirmed*.
2. **[Expert]** Click **Withdraw from this project**. Nothing has happened yet.
   A confirmation opens that names the project and states the consequences:
   whether a seat is released or an acceptance is withdrawn, how many work items
   still waiting on them will be cancelled, that work already submitted is kept
   along with any payment prepared for it, and that they cannot undo this
   themselves.
3. **[Expert]** Optionally fill **Reason (optional)**. A withdrawal with no
   reason is accepted; the operator's attention item then reads *No reason was
   given*. **Keep this project** backs out with nothing changed.
4. **[Expert]** Click **Confirm withdrawal**. The commitment leaves the list and
   appears under **Projects you have withdrawn from** with a **Withdrawn**
   badge. Work that was still waiting on them now shows *cancelled* in *Your
   work*. Clicking again, or resubmitting the same request, changes nothing
   further.

Withdrawal works from an accepted invitation before any assignment exists, and
from a proposed or confirmed assignment. It releases only the commitment on that
one project; seats the expert holds elsewhere are untouched.

Withdrawing is not a ban. If the same expert becomes available again, invite
them to the project as usual: accepting re-opens their released seat record and
the *Staffing* table offers **Propose** again.

### What the operator sees

5. **[Operator]** *Needs attention* carries a high-severity item, *<name>
   withdrew from <code>*, with the reason as its **Blocker**, the seats now
   unfilled as its **Impact**, and reviewing replacement recommendations as its
   **Next**. Click **Take this** before working it.
6. **[Operator]** On the project, the *Seats* tile has gone back to `0/1` with
   *1 open*, and the project status badge reads *staffing* again. A project that
   had become *active* on being fully staffed is returned to *staffing*,
   because an active project accepts no invitations and the replacement would
   otherwise be unreachable.
7. **[Operator]** *Delivery* shows the cancelled work item. Work the expert had
   already submitted is still there, still reviewable, and any payment item
   already prepared for approved work is untouched on *Payments*.

### The replacement outreach

8. **[Worker]** A replacement batch is assembled from the project's latest match
   run, excluding anyone already invited or assigned, anyone archived, and
   anyone whose own time on this project has ended: a withdrawn invitation or a
   released seat. The person who just left is not proposed as their own
   replacement. It is a draft. Nobody has been contacted. If there is nobody
   left to approach, you get a *No replacement candidates* item instead.
9. **[Operator]** *Outreach*. The batch is in the table with kind *replacement*,
   created by *the worker*. Open it. Each recipient shows a rationale and
   *not attempted yet*. There is no dispatch control in this state.
10. **[Operator]** Click **Submit for approval**. The batch moves to *pending
    approval*.
11. **[Operator, second identity]** In the second operator's profile, open the
    batch and click **Approve**. Rejecting requires a **Note (required to
    reject)**. An operator whose role cannot approve sees an explanation rather
    than a button, and the operator who created a large batch cannot approve
    their own.
12. **[Operator, second identity]** Click **Dispatch to N recipients**. Only now
    is anyone contacted. Each row reports its own outcome, including a permanent
    skip with its reason for anyone who became ineligible between approval and
    dispatch. Dispatching a finished batch again invites nobody twice.

### Staffing the replacement

13. **[Worker]** Invitation messages are dispatched to the outbox.
    **[Simulated]** Copy the replacement's **Portal link (dev only)**.
14. **[Expert, replacement]** In a third browser profile, open the link and
    click **Accept** under *Open invitations*.
15. **[Expert, replacement]** Under *Your availability*, fill **From**, **To**
    and **Hours/week** and click **Add window**.
16. **[Expert, replacement]** Complete every field and attestation in
    *Onboarding checklist* and click **Submit for review**.
17. **[Operator]** *Verification*. Click **Verify expert** on their card. Until
    this happens the project's *Staffing* table shows *Waiting on operator
    verification* where the propose button would be.
18. **[Operator]** On the project, set **h/week** and **Rate USD/h**, click
    **Propose <first name>**, then click **Confirm seat**. The *Seats* tile
    returns to `1/1`.

Only now is the replacement staffed. Work can be assigned to them, submitted,
reviewed and approved exactly as in [Flow D](#flow-d--delivery-and-review), and
payment prepared as in [Flow G](#flow-g--payment-preparation). Assigning work
before the seat is confirmed is refused: work exists against a confirmed seat.

---

## Flow G — payment preparation

1. **[Worker]** An approved work item becomes a draft payment item, once. A
   retry or a second approval does not create a second row. Quantities that do
   not match what was claimed arrive flagged.
2. **[Operator]** *Payments*. Select the items and click **Create batch of N**,
   then **Submit for approval**.
3. **[Operator]** Clicking **Approve** on a batch you created is refused, and
   says so. **[Operator, second identity]** The second operator clicks
   **Approve**.
4. **[Payment prep]** Click **Export CSV**. The page then reads *Exported. Not a
   record of payment.* That is literal: ExpertOps produces a file and an
   approval record. It holds no payment credentials, contacts no payment
   provider, and moves no money. Whether anyone was paid is not knowledge this
   system has.

---

## Ending an engagement

Closing a project opens an offboarding checklist for everyone staffed on it.
Each item is something you do elsewhere and then confirm here, with a note,
because your statement is the only evidence the system has. ExpertOps does not
revoke accounts, terminate contracts or delete anything outside itself, and
nothing in the checklist claims it did.

---

## What is real, what is simulated

| Thing | State |
| --- | --- |
| Ranking, gap detection, reminders, drafts | Real, and the worker does them |
| Verification, approvals, reviews, dispatch | Real, and a named person does them |
| Email | Simulated. Written to *Outbox*, never sent |
| Magic links | Real, single-use tokens; shown in the UI only in development |
| Payment | Preparation and export only. No money moves |
| Anything outside ExpertOps | Not touched. Accounts, contracts and tools are yours to handle |

---

## Recording what you find

Keep one note per observation. Four fields are enough, and the fourth is the one
people skip and later need.

1. **Where you were.** The URL, and the name of the card or section.
2. **What you did.** The exact control you clicked or the field you filled.
3. **What happened.** The message shown, or nothing at all. Copy the text.
4. **What you expected instead.** Even when you are unsure whether it is a bug.

Worth recording specifically:

- **A confusing screen.** Anything where you had to guess what a control would
  do, or could not tell whether an action had taken effect.
- **A failed action.** Copy the error text verbatim. If the response carried a
  correlation id (`x-correlation-id`), include it: the logs can be found by it
  without guessing at timestamps.
- **Missing information.** A decision you were asked to make without being shown
  what you needed to make it.
- **A wrong label.** Any instruction in this document that does not match the
  screen. The screen is right and the document is wrong; say which step.
- **Anything that felt automatic that should not be.** Especially anything that
  looked like it contacted a person, verified someone, or approved something
  without a named operator doing it.
