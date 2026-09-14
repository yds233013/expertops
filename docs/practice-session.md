# Practice session

A scripted run through the parts of ExpertOps worth rehearsing, on records that
already exist so you are not building a board before you can play on it.

Every practice record is prefixed **PRACTICE**. Nothing here is real: email is
simulated, no payment executes, and the client does not exist.

The longer reference guide is [`walkthrough.md`](walkthrough.md). This one is
narrower on purpose — it takes the scenario already seeded and walks it.

---

## What is already there

Seeded by `scripts/practice-scenario.ts`. Re-running it creates nothing a second
time, so it is safe if you want the board back after experimenting.

| Record | What it is for |
| --- | --- |
| **PRJ-0002 · PRACTICE evaluation pilot** | Two seats, requires *Evaluation Design*, rate ceiling $250/h |
| **PRACTICE Nadia Halvorsen** | Verified, availability on file. The seat can be confirmed for her |
| **PRACTICE Tomas Ferreira** | Onboarding unfinished. Looks staffable in a list and is not |
| **PRACTICE Ingrid Sørensen** | Held back. Use her when somebody withdraws |
| **PRACTICE evaluation screening** | A published rubric, v1 |
| **PRACTICE Rosa Imani** | A candidate waiting to be screened |

Nothing is invited and nobody is staffed. Those are the steps to practise.

---

## Before you start

Two sign-ins, in this order: the browser asks for the site gate first, then the
application asks for an operator account. Both sets of credentials are in the
file outside this repository — they are deliberately not written down here.

You will need **two operator identities** for the payment step, because a batch
cannot be approved by whoever created it.

For the expert portal you need a second browser profile, not a second incognito
window: every incognito window shares one session, so signing in twice replaces
the first rather than sitting beside it.

---

## 1. Screen a candidate

**Actor: operator.**

| | |
| --- | --- |
| **Where** | Sidebar → **Sourcing** → **Candidates** → open *PRACTICE Rosa Imani* |
| **Enter** | Choose **PRACTICE evaluation screening** as the published rubric version, then click **Send screening** |
| **Expect** | A reference like `SCR-0001` appears on the candidate |
| **If not** | If the rubric is not in the list, it has no published version — open **Rubrics**, check v1 says *published*, not *draft* |

**Actor: candidate.** Open **System → Outbox**, find *Screening exercise* for
Rosa, and copy the link in the message body. Open it in a second browser
profile.

| | |
| --- | --- |
| **Where** | The screening page, reached by that link |
| **Enter** | For *Describes a defensible evaluation method*, write two or three sentences. For *Points at real prior work*, paste any URL — `https://example.test/sample` is fine |
| **Expect** | **Submit responses** is accepted and the page confirms it |
| **If not** | "Required evidence is missing" means one criterion needs a link and got prose. Your answers are kept; fill the missing field and resubmit |

**Actor: operator.** Back in **Sourcing → Screening**.

| | |
| --- | --- |
| **Where** | The card for Rosa |
| **Enter** | Score each criterion, write feedback the candidate will read, and optionally a private note. Click **Ask for a revision** |
| **Expect** | The candidate's page shows *Requested changes* with your feedback, and not the private note |
| **If not** | If the card offers **Assign a reviewer** instead of a form, the worker has not assigned one yet — pick yourself and click **Assign** |

Then have the candidate resubmit, and this time **Recommend approve**, and
finally **Qualify** with a decision note. Rosa becomes an expert.

> Worth doing once: open the candidate's page as the candidate and confirm the
> private note is not on it. The separation is the point of having two fields.

---

## 2. Staff the project

**Actor: operator.**

| | |
| --- | --- |
| **Where** | Sidebar → **Staffing** → **Projects** → *PRACTICE evaluation pilot* |
| **Enter** | Click **Open for matching**, then **Run matching** |
| **Expect** | A ranking naming the algorithm version, how many were considered, ranked and excluded. Anyone excluded is listed with a reason |
| **If not** | If Nadia is missing, check she has *Evaluation Design* on her record — a required skill is a hard filter, and an expert without it is excluded from every match |

| | |
| --- | --- |
| **Where** | The ranking row for **PRACTICE Nadia Halvorsen** |
| **Enter** | Click **Invite**, add a short note, then **Send invitation** |
| **Expect** | The row reads *sent*. A moment later the message is in the Outbox |
| **If not** | If the project refuses invitations, check its status — an `ACTIVE` project accepts none, because it has no seat to offer |

**Actor: expert.** Copy the portal link from the Outbox message and open it in
the second profile. Accept, declare availability (any dates, 20 h/week), and
complete the onboarding checklist. Use `PRACTICE-BILL-0001` for the billing
reference.

**Actor: operator.** **Staffing → Verification**, then **Verify expert**.

| | |
| --- | --- |
| **Where** | Back on the project, the *Staffing* table |
| **Enter** | Set **h/week** to `20`, leave the rate, click **Propose Nadia** then **Confirm seat** |
| **Expect** | The *Seats* tile moves to `1/2`. The action becomes **Release seat** |
| **If not** | If the Action column shows text rather than a button, that text is the blocker. Unverified onboarding and no declared availability are the two usual ones |

**Now try Tomas.** He is the point of the exercise: invite him, and before he
finishes onboarding try to propose him. The staffing row will tell you why it
cannot happen rather than simply leaving him out.

---

## 3. Assign and review work

**Actor: operator.**

| | |
| --- | --- |
| **Where** | Sidebar → **Delivery** → **Work** |
| **Enter** | Choose Nadia's seat. Title: `PRACTICE scoping note`. Instructions: two sentences. Basis: *Hourly*. **Due date: set one** |
| **Expect** | `WRK-…` is created and appears in the expert's portal |
| **If not** | "No confirmed seats yet" means nobody is staffed — finish step 2 first |

> The due date is not decoration. Overdue detection selects on it, so an item
> without one can never be reported late.

**Actor: expert.** In the portal, submit the work with a summary, what you did,
and `6` hours.

**Actor: operator.** Back on **Work**, click **Review WRK-…**.

| | |
| --- | --- |
| **Enter** | A summary, then set **Approved hours** to `5` rather than 6 |
| **Expect** | Approving fewer hours than claimed is allowed, and the payment item is flagged for an explanation instead of being quietly adjusted |
| **If not** | If no payment item appears, check **System → Worker** — payment drafting is a background job |

---

## 4. Withdrawal and replacement

**Actor: expert.** In Nadia's portal, under *Leaving a project*, click
**Withdraw from this project**, read what the confirmation says will happen, give
a reason, and confirm.

| | |
| --- | --- |
| **Expect** | The seat releases, the project returns to *staffing*, and **Needs attention** raises a high-severity item naming her |
| **If not** | If the project stays *active*, the seat count did not drop — check the *Seats* tile before assuming the withdrawal failed |

**Actor: operator.** The worker drafts a replacement batch within a minute or
two.

| | |
| --- | --- |
| **Where** | Sidebar → **Staffing** → **Outreach** |
| **Enter** | Open the replacement batch, **Submit for approval**, **Approve**, then **Dispatch** |
| **Expect** | Three separate steps, each recorded against you. Ingrid receives an invitation |
| **If not** | If no batch appears, check **Needs attention** — "no replacement candidates" means everybody is already invited or assigned |

Then take Ingrid through accept → availability → onboarding → verification →
propose → confirm, and the project is back to `2/2`.

---

## 5. Payment preparation

**Actor: operator one.**

| | |
| --- | --- |
| **Where** | Sidebar → **Delivery** → **Payments** |
| **Enter** | Tick the practice payment item, set a period, **Create batch**, then **Submit for approval** |
| **Expect** | The batch reads *pending approval* |
| **If not** | An item held in *needs explanation* has a discrepancy — record why the figures differ before it can enter a batch |

| | |
| --- | --- |
| **Enter** | Now click **Approve** yourself |
| **Expect** | **Refused**: a batch must be approved by someone other than its creator. The batch stays pending |
| **If not** | If it approves, the batch was created by a different account than the one you are signed in as |

**Actor: operator two.** Sign out, sign in as the second operator, and
**Approve**, then **Export CSV**.

| | |
| --- | --- |
| **Expect** | The batch reads *exported* and is badged **not paid**. The file has one row per payment item and no field that records payment at all |
| **If not** | If **Approve** is missing, the second account lacks the ADMIN role, which is what carries `payment:approve` |

---

## Putting the board back

Run the seeder again to restore anything you consumed:

```
npx tsx scripts/practice-scenario.ts
```

It creates only what is missing. Records you have moved through the workflow
stay where you left them — it will not rewind a staffed seat or an approved
batch, so for a clean second run use fresh names.

---

## 6. Apply to an opportunity yourself

The three `PRACTICE` opportunities are published and waiting. This journey is
deliberately left for you to complete; nothing about it has been done for you.

**Actor: applicant.** Open the opportunities page in a browser profile that is
**not** signed in as an operator. You still pass the site gate; that is the
staging perimeter, not an account.

| | |
| --- | --- |
| **Where** | `/apply/opportunities` |
| **Expect** | Three listings: code review, enterprise process, security review. Each labelled *Project engagement* |
| **If not** | An empty list means none is published. Check **Opportunities** in the operator sidebar: a draft is invisible here by design |

| | |
| --- | --- |
| **Where** | Open one and read it |
| **Expect** | Description, responsibilities, required skill, expected hours, deadline, and a compensation line saying none is offered. No client name anywhere |
| **If not** | If you can see a client name or a rate ceiling, that is a leak worth reporting — it should only exist in *Internal notes* on the operator side |

| | |
| --- | --- |
| **Enter** | Your own synthetic details. Use an address you have not used before, something like `practice.applicant@example.test`. Answer the required question |
| **Expect** | A confirmation with an `APP-…` reference and three numbered steps |
| **If not** | "Please answer" means a required question is blank. "Not found" means the listing was closed while you were reading it |

**Try submitting the same form again.** You should be told you have already
applied, with the same reference, and the operator should still see one
applicant rather than two.

**Actor: operator.** In another profile, signed in.

| | |
| --- | --- |
| **Where** | Sidebar → **Sourcing** → **Opportunities** → the one you applied to |
| **Expect** | Your application under *Applicants*, with a next action of "Read the application, then send a screening" |
| **If not** | Check the email you used; the applicant list is scoped to that opportunity |

Open the application, read what you submitted, then **send a screening** using
the `PRACTICE evaluation screening` rubric. From there the existing screening,
revision, qualification and project-invitation steps in this guide apply
unchanged — an applicant becomes a candidate becomes an expert.

> To practise withdrawal you need the screening link the operator sends, because
> application status and withdrawal live behind the candidate session. Read the
> link out of **System → Outbox** and open it in the applicant's profile.
