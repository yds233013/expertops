# Staging verification run

One full staffing lifecycle driven against the hosted deployment on
13 September 2026: invitation, onboarding, staffing, expert-initiated
withdrawal, and replacement. Everything below happened on
`https://web-production-09e7e.up.railway.app`, against Railway's PostgreSQL,
with the background worker running as its own service.

Every record is synthetic. No message left the machine.

## How it was driven, and why not through the browser

Over HTTPS with `curl`, against the same REST routes under `/api/` that the
browser UI calls, with the tester gate enforced on every request, a real
operator session cookie and a real CSRF token on every mutation.

Not through the browser, because the outer gate is HTTP Basic authentication and
the browser automation available here refuses credentials embedded in a URL;
a native credential dialog blocks the automation outright. Lifting the gate for
the duration was the alternative and was rejected — it would have left the
sign-in page reachable by anyone for the length of the run.

So this run proves the routes, the services, the worker and the database. It
does not prove that the pages render correctly in a browser against this
deployment. That remains open.

## What happened

| # | Actor | Action | Result |
| --- | --- | --- | --- |
| 1 | Operator | Sign in | ADMIN session, 47 capabilities |
| 2 | Operator | `DRAFT` → `MATCHING` → `INVITING` on PRJ-0001 | accepted in that order; `DRAFT → STAFFING` refused |
| 3 | Operator | Run matching | 4 considered, 4 candidates, 0 excluded |
| 4 | Operator | Outreach batch BAT-0001, submit, approve, dispatch | `DRAFT → PENDING_APPROVAL → APPROVED → DISPATCHED` |
| 5 | Worker | `outbox.dispatch` | messages marked `SENT`, nothing emailed |
| 6 | Expert Bo | Redeem magic link, accept | invitation `ACCEPTED`, onboarding case opened |
| 7 | Expert Bo | Complete 6 checklist items, submit | `SUBMITTED`, awaiting operator |
| 8 | Expert Dara | Same | `SUBMITTED` |
| 9 | Operator | Verify both | both cases `VERIFIED` |
| 10 | Experts | Declare availability | required before staffing; the proposal is refused without it |
| 11 | Operator | Propose and confirm two assignments | both `CONFIRMED`, project `ACTIVE`, seats 2/2 |
| 12 | Expert Bo | **Withdraw** | see below |
| 13 | Worker | `staffing.propose_replacements` | replacement batch BAT-0002 created |
| 14 | Operator | Approve and dispatch BAT-0002 | `DISPATCHED` |
| 15 | Expert Avery | Accept, onboard, declare availability | `VERIFIED` |
| 16 | Operator | Propose and confirm | `CONFIRMED`, project `ACTIVE`, seats 2/2 |

## The withdrawal

One request to `POST /api/portal/withdrawals`. The expert id comes from the
portal session, never from the request body.

Synchronous, inside the one transaction:

- assignment → `RELEASED`, with `releaseReason` carrying the expert's own words
- `seatsFilled` 2 → 1
- project `ACTIVE` → `STAFFING`, because a gap opened and an `ACTIVE` project
  accepts no invitations
- invitation → `WITHDRAWN`
- attention item raised: "SYNTHETIC Bo Okonkwo withdrew from PRJ-0001"
- `staffing.propose_replacements` enqueued

Afterwards, by the worker: the replacement batch itself, and a second attention
item saying it needs approval. A batch does nothing until a person approves it.

## The exclusion fix, confirmed on the deployment

BAT-0002 proposed **Avery Lindqvist** and **Cleo Marchetti**. It did not propose
Bo Okonkwo, who had just withdrawn, and it did not propose Dara Nkemelu, who was
still assigned. This is the regression found during the local walkthrough, now
confirmed fixed against a real deployment.

## Access control, as observed

| Path | Unauthenticated |
| --- | --- |
| `/` | 401 with `WWW-Authenticate: Basic` |
| `/portal` | 401 |
| `/api/outbox` | 401 |
| `/api/health` | 200 — deliberately exempt, so the platform health check works |

Responses also carry `X-Robots-Tag: noindex, nofollow, noarchive`.

## Findings

**Portal links are readable in the outbox regardless of
`EXPOSE_PORTAL_LINKS_IN_UI`.** The flag hides the separate `devPortalUrl` field,
but `renderInvitationEmail` writes the portal URL into `bodyText`, and the
outbox page renders `bodyText` unconditionally. That is how this run obtained
the magic links, and on a staging box with simulated email it is arguably the
only way a tester could ever reach the portal. It is still worth deciding
deliberately rather than inheriting: anyone with `outbox:read` can currently
take over any expert's portal session. Not changed here.

**Two experts is not enough fixture data to rehearse a withdrawal.** The
sandbox project has two seats and `staging-fixtures.ts` created exactly two
experts, so there was nobody left to propose as a replacement. Two more
synthetic experts were added to the script.

## Worker health

24 jobs ran during the session. All succeeded on the first attempt; no retries,
no dead jobs. `p95` latency on the web service was 50 ms over 96 requests, with
no 5xx.
