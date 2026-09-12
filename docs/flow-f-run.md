# Flow F run log — withdrawal and replacement

A record of running [Flow F of the walkthrough](walkthrough.md#flow-f--an-expert-withdraws-and-a-replacement-is-staffed)
by hand in a browser, against the local development instance, starting from
commit `0a82875`. Every step was a click or a keystroke on a real screen. No
database writes and no API calls were used to get past anything.

It took two runs. The first found a defect and was stopped on purpose; the
second, after both fixes, completed all nine steps. Both fixes are in commit
`7201425`.

Everything below is synthetic. Two synthetic experts, two synthetic projects,
one synthetic client, and the seeded development operator accounts.

---

## The two runs

| | Run 1 — interrupted | Run 2 — successful |
| --- | --- | --- |
| Project | PRJ-0020 `SYNTHETIC Withdrawal Walkthrough` | PRJ-0021 `SYNTHETIC Withdrawal Walkthrough - run 2` |
| Withdrew | Synthetic Wren Alcott, with a reason | Synthetic Wren Alcott, no reason |
| Replacement | none staffed | Synthetic Ida Moreau, confirmed |
| Outcome | stopped after step 5 | all nine steps passed |
| Left as | 0/1 seats, still `staffing` | 1/1 seats, `active` |

**Run 1** got as far as the operator reviewing the replacement proposal. The
batch the worker assembled named the expert who had withdrawn four minutes
earlier, described as "qualified and ready". It was rejected rather than
dispatched, so nobody was contacted, and PRJ-0020 was deliberately left
unstaffed as the evidence.

**Run 2** repeated the same journey after both defects were fixed, and is the
run that demonstrates the flow working end to end.

---

## What happens immediately, and what the worker does afterwards

This is the part the first write-up of this run got wrong, so it is spelled out
here. Withdrawal is not a request that schedules work for later. Almost all of
it is committed in one transaction before the expert's click returns.

**In the expert's own request**, inside the single transaction `recordWithdrawal`
opens:

- The assignment moves to `RELEASED`, and `seatsFilled` is recomputed from the
  assignment table under a project row lock.
- The project returns from `ACTIVE` to `STAFFING` when that leaves a gap, which
  is what makes the seat reachable by a new invitation.
- The accepted invitation becomes `WITHDRAWN`, carrying the reason.
- Work items still waiting on the expert (`DRAFT`, `ASSIGNED`,
  `REVISION_REQUESTED`) become `CANCELLED`. Submitted, approved and paid work is
  not touched.
- The attention items that were only true while they held the seat are resolved:
  each cancelled item's `work:overdue:`, plus `delivery:no_work:`,
  `staffing:ready:` and `staffing:blocked:`.
- The `assignment.expert_withdrew` audit event is written.
- The high-severity `staffing.withdrawal` attention item is **raised**.
- The simulated "seat released" message is **queued** in the outbox, if the seat
  had been confirmed.
- The `staffing.propose_replacements` job is **enqueued**.

**The background worker, afterwards:**

- Runs `staffing.propose_replacements`, which assembles the replacement batch
  from the project's latest match run and raises `outreach:awaiting_approval`.
  This is the only part of the withdrawal that is genuinely deferred.
- `outbox.dispatch` (every 15s) flips queued simulated messages to `SENT`, and
  renders dispatched invitations into the outbox.
- `attention.sweep` (every 120s) runs gap detection, which is what **resolved**
  the withdrawal item on PRJ-0021 once the replacement seat was confirmed.
- `payment.draft_from_approved_work` drafted PAY-0002. That was triggered by the
  operator approving work, not by the withdrawal.

So the worker did not release the seat, did not reopen the project, did not
cancel the work and did not raise the attention item. It assembled the
replacement list, moved the simulated mail, and later cleared the item.

---

## Identities, and the browser limitation

The automation drives **one Chrome profile**, and every tab in it shares one
cookie store. Audiences do not collide: operators authenticate with
`expertops_session` and the expert portal with `expertops_portal`, so one
operator and one expert are signed in at the same time without interfering.

Within an audience there is exactly one slot. Signing in as the second operator
replaced the first in every tab, and opening the replacement expert's magic link
replaced the first expert's portal session. This run therefore had **two live
sessions at a time, not four**. Each slot was time-shared between two identities
using the application's own **Sign out** control and fresh single-use magic
links, in an order where the two identities never needed to be live at once.

That is a limitation of the automation, not of the application, and it had one
visible consequence: two sign-out clicks landed before the page had finished
rendering and silently did nothing, so one verification and one seat proposal
were recorded against the admin rather than the operator. Both hold the
capability, so the actions were valid. The proposal was withdrawn and re-made
under the intended identity; the verification stands as the admin's, which is
why the history on PRJ-0021 names both people.

For a pilot with genuinely concurrent participants, give each person their own
Chrome profile or their own browser, as
[the walkthrough says](walkthrough.md#separate-identities-properly). Two private
windows in one browser are not enough.

---

## Defects found, and fixed

**The expert who withdrew was proposed as their own replacement.**
`recommendReplacements` skipped live invitations and assignments, but a
withdrawn invitation and a released seat are neither. Where matching had run
before the invitation went out — the order an operator actually works in — the
person who had just left was still a ranked candidate, so the worker's batch
listed them. Approving it would have re-invited them.
See [08](screenshots/flow-f/08-DEFECT-withdrawn-expert-proposed-back.jpg) and,
after the fix, [12](screenshots/flow-f/12-FIXED-replacement-excludes-leaver.jpg).

**A released seat could never be proposed again.** `RELEASED → PROPOSED` is in
the transition table and the staffing screen offers the propose form for a
released assignment, but `proposeAssignment` only ever created a row, so the
offered action failed with "already has an assignment record". This is reachable
by an expert withdrawing, an operator releasing a seat, or an operator
withdrawing a proposal, and it blocked confirming the replacement in run 2.

Both have regression tests in `tests/integration/expert-withdrawal.test.ts`,
each checked to fail against the previous implementation.

---

## Screenshots

Run 1, PRJ-0020:

1. [Seat confirmed](screenshots/flow-f/01-seat-confirmed-prj0020.jpg) — 1/1, project `active`.
2. [Leaving a project](screenshots/flow-f/02-portal-leaving-a-project.jpg) — the expert's own card, before any click.
3. [Consequences before confirming](screenshots/flow-f/03-withdrawal-consequences.jpg) — names the project, counts 1 item cancelled and 2 kept.
4. [After withdrawal](screenshots/flow-f/04-portal-after-withdrawal.jpg) — withdrawn badge, outstanding item cancelled, submitted and approved work kept.
5. [Payment preserved](screenshots/flow-f/05-payment-preserved.jpg) — PAY-0002 still ready to batch.
6. [Capacity released](screenshots/flow-f/06-project-capacity-released.jpg) — 0/1, back to `staffing`.
7. [Attention item](screenshots/flow-f/07-attention-withdrawal-item.jpg) — blocker, impact and next action.
8. [The defect](screenshots/flow-f/08-DEFECT-withdrawn-expert-proposed-back.jpg) — the proposal includes the expert who just left.
9. [Approval gate](screenshots/flow-f/09-operator-cannot-approve-own-role.jpg) — the operator role can submit but not approve.
10. [Rejected](screenshots/flow-f/10-batch-rejected-with-reason.jpg) — 0 invited, reason recorded.

Run 2, PRJ-0021:

11. [Consequences, no outstanding work](screenshots/flow-f/11-run2-withdrawal-consequences.jpg) — the text adapts to the project.
12. [Fixed proposal](screenshots/flow-f/12-FIXED-replacement-excludes-leaver.jpg) — one recipient, not two.
13. [Approved and dispatched](screenshots/flow-f/13-batch-approved-and-dispatched.jpg) — by the second operator, 1 invitation created.
14. [Replacement staffed](screenshots/flow-f/14-replacement-staffed-1of1.jpg) — 1/1, project `active` again.
15. [Attribution](screenshots/flow-f/15-activity-attribution.jpg) — operator, expert and system on their own actions.
16. [Gap resolved](screenshots/flow-f/16-gap-resolved-attention.jpg) — the withdrawal item is gone; a no-work item takes its place.

The captures are page content only, with no address bar, so no magic-link token
appears in any of them. The operator addresses visible in page headers are the
seeded development accounts printed on the sign-in screen.

---

## What this run left in the development database

Two experts (EXP-0053, EXP-0054), one skill, two projects (PRJ-0020, PRJ-0021),
three work items, one payment item (PAY-0002) and two outreach batches — all
labelled synthetic. Nothing was reset or reseeded, and no real message, account
or payment was involved at any point.
