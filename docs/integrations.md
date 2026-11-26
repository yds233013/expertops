# Integrations: email, Slack, Stripe payouts

Each integration does nothing until it is configured. Unconfigured, the app
behaves exactly as the demo always has: email is simulated, Slack is silent,
and payment batches are exported as a file. Each one can be switched on alone.

| Integration | Switch | Without it |
| --- | --- | --- |
| Email through Resend | `EMAIL_PROVIDER=resend` | Simulated outbox: rows marked SENT, nothing leaves |
| Slack alerts | `SLACK_WEBHOOK_URL=…` | The scheduled job reports "not configured" and does nothing |
| Stripe Connect payouts | `STRIPE_SECRET_KEY=sk_test_…` | "Pay" is refused with a message; export still works |

A side effect outside the database cannot be rolled back. Each integration
handles that in its own way, so each section below ends with **what can go
wrong, and what stops it**.

---

## Email (Resend)

### Setup

1. Create a Resend account and verify a sending domain.
2. Set:
   ```
   EMAIL_PROVIDER=resend
   RESEND_API_KEY=re_...
   EMAIL_FROM="ExpertOps <ops@your-verified-domain>"
   EMAIL_ALLOWED_DOMAINS=your-company.com   # optional; recommended for a pilot
   RESEND_WEBHOOK_SECRET=whsec_...          # from the webhook you create in step 3
   ```
3. In Resend, add a webhook to `https://<your-app>/api/webhooks/resend` for
   `email.delivered`, `email.bounced` and `email.complained`.

### How a message is delivered

`outbox.dispatch` runs every 15 seconds. For each QUEUED message:

1. **Guard.** The message is marked `SUPPRESSED` with a reason, and never sent,
   when the address:
   - is on the suppression list.
   - is on a reserved test domain (`*.test`, `*.example`, `*.invalid`,
     `*.localhost`, `example.com/.net/.org`). Every seeded and test address is
     on one of these, so pointing a real provider at a seeded database sends
     nothing.
   - is outside `EMAIL_ALLOWED_DOMAINS`, when that is set.
2. **Send.** A request to Resend with `Idempotency-Key: outbox-<message id>`.
3. **Record.** The status changes by conditional update on `status = QUEUED`:
   - Success: the message becomes `SENT`, with Resend's message id.
   - 429, 409, 5xx or a network failure: it stays `QUEUED`, the attempt count
     goes up and the error is recorded. After 5 attempts it becomes `FAILED`.
   - Any other 4xx: it becomes `FAILED` straight away.

A `FAILED` message raises an **automation-failure** attention item: the person
never got the email, and someone has to reach them another way.

### Webhooks

`/api/webhooks/resend` verifies the Svix signature (HMAC-SHA256 over
`id.timestamp.body`) against the raw body, and refuses timestamps more than 5
minutes away. Then, in one transaction:

1. It records the event id in `WebhookEvent`. A redelivery hits the unique key
   and is acknowledged as `duplicate` without being applied.
2. `email.delivered` sets `deliveredAt`.
3. `email.bounced` marks the message `BOUNCED` and suppresses the address.
4. `email.complained` suppresses the address.

With no `RESEND_WEBHOOK_SECRET` the endpoint answers **503**, never "accept
unsigned".

### What can go wrong, and what stops it

| Risk | Guard |
| --- | --- |
| The worker sends, then its transaction rolls back (lease takeover, crash) | The retry uses the same idempotency key, and Resend returns the original result instead of sending again. Keys last 24 hours, far longer than any retry here |
| Two workers pick up the same message | The same idempotency key, plus the conditional status update |
| Mailing a seeded or fixture address | Reserved domains are refused before any request |
| Mailing someone outside a pilot | `EMAIL_ALLOWED_DOMAINS` |
| Repeated bounces hurting the sending domain | Bounced and complaining addresses are suppressed for good |
| A forged webhook | Signature, timestamp window, and 503 when no secret is configured |

**Not done yet:** HTML email, an unsubscribe link and preference centre, per-
domain send-rate limits, and a screen for removing an address from the
suppression list (do it in the database for now).

---

## Slack

### Setup

Create an incoming webhook for a channel (Slack app → Incoming Webhooks), then:

```
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
SLACK_MIN_SEVERITY=MEDIUM   # LOW, MEDIUM (default) or HIGH
```

### Behaviour

The `slack-notify` schedule runs every 60 seconds and posts up to 10 open
attention items that meet the severity threshold, have not been posted, and
were raised in the last 24 hours. The 24-hour limit means switching Slack on
does not post the whole history.

Each message gives the kind (needs attention, or automation failure), the
severity, the title, the blocker, the next action and a link to the queue. Item
text is escaped, so a title cannot ping `@channel` or hide a link.

### What can go wrong, and what stops it

Each item is claimed by setting `slackNotifiedAt`, conditionally, before the
post, inside the job transaction. A second worker waits on that row and then
finds it taken. If Slack refuses the post, the job throws, every claim rolls
back, and the next run tries again.

Slack incoming webhooks have no idempotency key, so one failure case is
accepted: a worker that dies **after** Slack accepted the post and **before**
committing causes one duplicate message. A duplicate alert is acceptable. A
lost one is not.

---

## Stripe Connect payouts (test mode only)

### Why test mode only

`stripeConfig` refuses any key that does not start with `sk_test_` or
`rk_test_`. Paying real people needs contractor agreements, tax forms, a funded
platform balance and a legal entity, and a live key pasted into the wrong
environment must not be able to move money. Removing that check is a
deliberate code change, not a configuration mistake.

### Setup

1. In a Stripe account, in test mode, enable Connect.
2. Set:
   ```
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   STRIPE_CONNECT_COUNTRY=US      # default US
   ```
3. Add a webhook endpoint at `https://<your-app>/api/webhooks/stripe`. Choose
   "Listen to events on Connected accounts" and select `account.updated`.
   Locally: `stripe listen --forward-connect-to localhost:3000/api/webhooks/stripe`.
4. Add test funds to the platform balance, or transfers fail with
   `balance_insufficient`. Create a test charge with the card
   `4000 0000 0000 0077`, which makes the funds available immediately.

### The flow

1. **The expert sets up payouts** from the portal ("Get paid"):
   - The first click creates a connected Express account. It is idempotent per
     expert, so two quick clicks create one account.
   - Each click makes a fresh Stripe-hosted onboarding link. Links expire within
     minutes, so they are never emailed.
   - Stripe collects identity, bank details and, for US experts, the tax
     information behind a 1099. **This system never sees any of it.**
2. **Stripe reports the account state** with `account.updated`. The webhook
   updates `payoutsEnabled` and the list of outstanding requirements. Nothing
   here guesses at whether an expert can be paid.
3. **An admin pays an approved batch**, which needs the `payment:payout`
   capability:
   - It is refused, with names, unless every expert in the batch can receive
     payouts. A batch is never half-paid because someone had not finished
     onboarding.
   - The batch moves `APPROVED → PAYING`, then one transfer is made per item
     with idempotency key `payment-item-<id>`.
   - Each item is marked `PAID`, with its transfer id, as soon as its own
     transfer succeeds.
   - A failed transfer leaves its item unpaid with the error recorded. Pressing
     Pay again retries only the unpaid items.
   - When nothing is left unpaid, the batch is `PAID`.

A batch ends either `EXPORTED` (a file was handed to finance) or `PAID` (money
moved in test mode), never both.

### What can go wrong, and what stops it

| Risk | Guard |
| --- | --- |
| Double click, retry, or a crash halfway through a batch | The idempotency key per payment item: Stripe returns the first transfer for a repeated key. Items update conditionally on `IN_BATCH` |
| A paid item lands in a second batch | `PAYING` and `PAID` count as active batches, and an item in one cannot be batched again |
| "Correcting" a paid item creates a second payment | Corrections are refused for paid items and for items in a paying batch |
| Someone pays their own batch unchecked | Approval still needs a different person from the batch's creator, and paying needs admin |
| Paying an expert who cannot receive money | Refused before any transfer is made |
| A live key | Refused at configuration |
| A forged account update | The SDK's signature check, plus the receipt table for redeliveries |

**Not done yet:**
- Reversing a transfer (refunds and clawbacks).
- Payouts in more than one currency. A batch is one currency, and the platform
  balance must be in that currency.
- Forcing a check of the tax-form state before paying. Stripe collects tax
  details during onboarding, but this build does not block a payout on them.
- Any live-mode path.

---

## Files

| Area | Code |
| --- | --- |
| Email provider and recipient guard | `src/server/email/provider.ts` |
| Dispatch | `src/server/services/outbox.ts` (`dispatchQueuedMessages`) |
| Webhook signature and receipts | `src/server/integrations/webhooks.ts` |
| Resend events | `src/server/integrations/resend-events.ts`, `src/app/api/webhooks/resend/route.ts` |
| Slack | `src/server/integrations/slack.ts` |
| Stripe gateway | `src/server/integrations/stripe.ts` |
| Payouts | `src/server/services/payouts.ts`, `src/app/api/webhooks/stripe/route.ts`, `src/app/api/portal/payouts/route.ts` |
| Tests | `tests/unit/integrations.test.ts`, `tests/integration/integrations.test.ts` |

The tests run every path against fakes: a scripted email provider, a fake
`fetch`, and a fake payout gateway that honours idempotency keys. No test
reaches Resend, Slack or Stripe.
