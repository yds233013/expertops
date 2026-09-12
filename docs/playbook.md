# Operator playbook

A short guide to running a day in ExpertOps. It assumes the app and the worker
are both running.

---

## Start here, every time

**Needs attention** is the working surface. Everything that is stuck and needs a
person is on it, and nothing else is. An empty list genuinely means nothing is
waiting.

Work it top down. Items are ordered by severity, then by what is most overdue.

Four things are true of every item:

- **Blocker** — the concrete thing that is stuck.
- **Impact** — what it costs if nobody acts.
- **Next** — what to do about it.
- **Owner** — a person, or explicitly *unassigned*.

Take an item before you work it. An unassigned high-severity item that has sat
for a day is usually a sign that everyone assumed someone else had it.

Items disappear on their own when the blocker clears. You do not close them.
Dismissing is for the case where the system is wrong or the situation is
knowingly accepted, and it asks for a reason because six weeks later nobody will
remember.

**Automation failures** are in their own section. Those are engineering
problems: a job stopped retrying, and something did not happen. Retry it from
the Worker screen once the cause is fixed.

---

## The shapes of work

### "PRJ-xxxx is N expert(s) short"

Read the next action. It says one of two things.

*"Nobody is in the funnel"* means recruiting, not chasing. Open a sourcing
campaign for the domain, or go back to the project and ask whether the
requirements are tighter than the work actually needs.

Anything else means there are people in flight. Go to the project, look at the
ranked candidates, and send more invitations.

### "X accepted but cannot be staffed"

The blocker names the reason. In rough order of how often it happens:

- *Waiting on operator verification* — go to **Verification** and review it.
- *No availability declared* — the expert has to add a window in their portal.
  Nothing you can do from your side except ask.
- *Blocked by support request SUP-xxxx* — open it under **Support**. Someone
  marked it as blocking, which means it genuinely stops them starting.
- *Qualification: ...* — they do not meet what the project requires. Either they
  need screening against the newer rubric, or the project's bar is wrong.

### "X may already exist"

Two records might be the same person. Compare them and decide.

Confirming a match withdraws the newer record and points at the original. It
does **not** merge anything: both records stay, with their history. That is
deliberate, because an incorrect merge cannot be undone.

Say *different people* if you are not sure. A wrong hold costs a day; a wrong
merge costs the record.

### "Reviewers disagree on SCR-xxxx"

Read both reviews, then record a resolution with your reasoning. The system will
not pick a winner and will not let anyone qualify or reject the candidate until
someone does. Resolving a conflict is admin-only.

### "X is Nh late reviewing SCR-xxxx"

The reviewer has had up to two reminders. If it says *"Reminders are exhausted"*,
stop chasing and reassign it. A candidate waiting a week on a review that is not
coming is a worse outcome than a reviewer being mildly annoyed.

### "Batch BAT-xxxx needs approval"

The system assembled a list of people to contact. Nothing has been sent.

Read the recipients and the rationale on each. Approve, or reject with a reason.
A batch of more than five people cannot be approved by whoever created it.

Approving does not send. Dispatch is a second, explicit click, and any recipient
who became ineligible in the meantime is skipped with the reason recorded.

### "Payment PAY-xxxx has discrepancy flag(s)"

Something does not line up. Usually the reviewer authorised fewer hours than the
expert claimed.

You have two choices:

- **Explain it.** The figure is right, the difference has a reason. Write the
  reason. The flag clears and the amount stands.
- **Correct it.** The figure is wrong. The item is superseded: the original is
  kept and voided, a replacement carries the new number, and any approval that
  covered the old number is withdrawn.

Either way, a flagged item cannot enter a batch until this is done.

---

## Running a hire, end to end

1. **Application arrives.** Acknowledged automatically. An item appears saying a
   screening has not been started.
2. **Start a screening.** Pick a published rubric version. The candidate gets a
   single-use portal link through the simulated outbox, which opens their own
   screening page: instructions, the criteria, a form, and a deadline.
   Rubrics themselves are authored under **Rubrics**; publishing a version
   freezes it, and changing it means drafting the next one.
3. **They submit.** An incomplete submission is accepted and marked incomplete
   rather than bounced; you can still see what they attempted.
4. **A reviewer is assigned automatically.** If nobody is eligible, that becomes
   an exception rather than a silent stall.
5. **Review.** Score against the rubric. Private notes are operator-only and
   never reach the candidate; public feedback does.
6. **Decide.** Qualify or reject. Qualifying converts them into a network expert
   and opens onboarding.
7. **Onboarding.** They complete the checklist; you verify it. This is the only
   route to `VERIFIED`.
8. **Invite them to a project, they accept, they declare availability.**
9. **Propose a seat, then confirm it.** Confirming is what consumes capacity.

Being qualified does not staff anybody. It makes them eligible. Every existing
staffing gate still applies.

---

## Running delivery

1. **Create a work item** from a confirmed seat under **Delivery**, with
   instructions and a basis. An hourly item makes the expert declare hours.
2. **They submit.** An item appears asking for review.
3. **Approve or request a revision.** A revision request needs a specific
   description of what to change.
4. **On approval, set the authorised quantity.** That number, and only that
   number, is what payment preparation reads. Approving fewer hours than claimed
   is fine and becomes a flag for someone to explain.

A review judges one submission. It does not change the expert's standing, and
nothing in the system aggregates reviews into a rating.

---

## Answering an expert

**Support** holds whole conversations, not a queue of subjects. Each one shows
who owns it, when the first response is due, and whether it is blocking anyone
from starting or delivering.

Two buttons, and the difference is the whole point of the screen:

- **Send reply** appears in the expert's portal.
- **Save internal note** never does. Internal notes are drawn with a dashed
  border and labelled *internal, not sent to the expert*, so a note is never
  mistaken for something they have already read.

A request marked as blocking readiness stops the expert being staffed, and the
staffing screen names the request as the reason. Resolving it clears the block;
that is why the resolution asks what was actually done.

---

## Preparing payment

1. Approved work becomes a draft payment item automatically.
2. Clear any discrepancy flags.
3. Gather ready items into a batch.
4. Submit it for approval. **Someone else** approves it.
5. Export the CSV.

**Exported is not paid.** The export records that a file was produced for a
finance process that lives outside this system. There is deliberately no action
anywhere that marks an expert as paid, because ExpertOps has no way to know
whether a transfer settled.

---

## When an expert withdraws

An expert can leave a project themselves, from the **Leaving a project** card in
their portal. You find out about it the same way you find out about everything
else: a high-severity item on *Needs attention*, titled *<name> withdrew from
<code>*. The reason is on the item when they gave one, and says so when they did
not — the portal does not force one.

What has already happened by the time you read it:

- The seat is released and the project's seat count is back down.
- The accepted invitation is withdrawn, so they are out of the funnel.
- Work that was still waiting on them is cancelled and its overdue reminders
  have stopped. Work they already submitted is untouched and still needs
  reviewing, and any payment already prepared for approved work is unaffected.
- A project that had gone *active* on being fully staffed is back to *staffing*,
  so the seat can be filled again.
- A replacement batch is being assembled from the project's latest ranking.

What is left to you: approve or reject that batch on *Outreach*, then dispatch
it. Nobody has been contacted before you do. A replacement who accepts still has
to declare availability, complete onboarding and pass your verification before
they can be proposed and confirmed onto the seat — a withdrawal does not
shortcut any of that. The full sequence is in
[`walkthrough.md`](walkthrough.md#flow-f--an-expert-withdraws-and-a-replacement-is-staffed).

If the seat gets filled another way, the withdrawal item resolves itself.

---

## Ending an engagement

Closing a project opens an offboarding checklist for everyone staffed on it.

Each item is something you do somewhere else and then confirm here. Confirming
requires a note, because the system cannot check: your statement is the only
evidence. ExpertOps does not revoke accounts, terminate contracts or delete
anything outside itself, and nothing in the checklist claims it did.

---

## Habits worth having

- **Work the queue, not your inbox.** If something needs doing and is not on the
  queue, that is worth reporting: the sweep should have caught it.
- **Write the reason.** Every field that asks for one is asked because someone
  will need it later, usually you.
- **Trust an empty queue.** It is computed from live state, not from what anyone
  remembered to tick off.
- **Watch the automation-failure count.** It should be zero. If it is not,
  something has silently not happened.
- **Check who approved what.** Approvals name the operator. That is the point of
  having them.
