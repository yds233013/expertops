import { createHmac } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { applyMigrations, truncateAll } from '../helpers/db';
import { buildRequest, callRoute, operatorToken } from '../helpers/api';
import {
  actorFor,
  actorForExpert,
  makeConfirmedAssignment,
  makeExpert,
  makeOperator,
  makeProject,
} from '../helpers/factories';
import { dispatchQueuedMessages, MAX_SEND_ATTEMPTS, queueMessage } from '@/server/services/outbox';
import { emailConfig, type EmailProvider, type SendOutcome } from '@/server/email/provider';
import { applyResendEvent } from '@/server/integrations/resend-events';
import { postAttentionToSlack, slackConfig } from '@/server/integrations/slack';
import { raiseAttention } from '@/server/services/attention';
import { HANDLERS } from '@/server/worker/handlers';
import { createWorkItem, reviewWork, submitWork } from '@/server/services/work';
import {
  approveBatch,
  correctPaymentItem,
  createBatch,
  draftPaymentFromApprovedWork,
  submitBatchForApproval,
} from '@/server/services/payments';
import { payBatch, startPayoutOnboarding, syncConnectedAccount } from '@/server/services/payouts';
import { type PayoutGateway, type TransferRequest } from '@/server/integrations/stripe';
import { POST as resendWebhook } from '@/app/api/webhooks/resend/route';
import { POST as batchAction } from '@/app/api/payment-batches/[batchId]/route';

async function expectAppError(promise: Promise<unknown>, code: string, pattern?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    if (pattern) expect((error as AppError).message).toMatch(pattern);
    return;
  }
  throw new Error(`expected the call to reject with ${code}`);
}

/** A provider that answers from a script and remembers what it was asked. */
class ScriptedProvider implements EmailProvider {
  readonly name = 'resend' as const;
  sent: string[] = [];
  constructor(private readonly answer: (to: string) => SendOutcome) {}
  async send(email: { to: string }): Promise<SendOutcome> {
    this.sent.push(email.to);
    return this.answer(email.to);
  }
}

const realConfig = emailConfig({
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 'k',
  EMAIL_FROM: 'ops@lab.dev',
});

function queue(toEmail: string) {
  return queueMessage(prisma, {
    toEmail,
    subject: 'Your invitation',
    bodyText: 'Hello',
    template: 'invitation.sent',
  });
}

describe('email delivery', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('keeps simulated delivery working for reserved test addresses', async () => {
    await queue('someone@example.test');
    const result = await dispatchQueuedMessages(prisma);
    expect(result).toMatchObject({ provider: 'simulated', delivered: 1, suppressed: 0 });
  });

  it('sends through a real provider and records the provider id', async () => {
    const message = await queue('ada@lab.dev');
    const provider = new ScriptedProvider(() => ({ kind: 'sent', providerMessageId: 're_1' }));

    const result = await dispatchQueuedMessages(prisma, { provider, config: realConfig });
    expect(result).toMatchObject({ delivered: 1, provider: 'resend' });
    const stored = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(stored).toMatchObject({
      status: 'SENT',
      provider: 'resend',
      providerMessageId: 're_1',
      attempts: 1,
    });
  });

  it('never calls a real provider for reserved, off-list or suppressed addresses', async () => {
    await queue('seeded@example.test');
    await queue('bounced@lab.dev');
    await queue('stranger@gmail.com');
    await prisma.emailSuppression.create({ data: { email: 'bounced@lab.dev', reason: 'BOUNCE' } });
    const provider = new ScriptedProvider(() => ({ kind: 'sent', providerMessageId: 'x' }));
    const config = emailConfig({
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 'k',
      EMAIL_FROM: 'ops@lab.dev',
      EMAIL_ALLOWED_DOMAINS: 'lab.dev',
    });

    const result = await dispatchQueuedMessages(prisma, { provider, config });
    expect(provider.sent).toEqual([]);
    expect(result.suppressed).toBe(3);
    const reasons = (await prisma.outboxMessage.findMany({ orderBy: { toEmail: 'asc' } })).map(
      (row) => [row.toEmail, row.status, row.suppressedReason],
    );
    expect(reasons).toEqual([
      ['bounced@lab.dev', 'SUPPRESSED', expect.stringMatching(/suppression list/)],
      ['seeded@example.test', 'SUPPRESSED', expect.stringMatching(/reserved/)],
      ['stranger@gmail.com', 'SUPPRESSED', expect.stringMatching(/EMAIL_ALLOWED_DOMAINS/)],
    ]);
  });

  it('retries a retryable failure, then gives up after the attempt limit', async () => {
    const message = await queue('ada@lab.dev');
    const provider = new ScriptedProvider(() => ({ kind: 'retry', error: 'Resend 503: busy' }));

    for (let attempt = 1; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
      const result = await dispatchQueuedMessages(prisma, { provider, config: realConfig });
      expect(result.retrying).toBe(1);
    }
    const last = await dispatchQueuedMessages(prisma, { provider, config: realConfig });
    expect(last).toMatchObject({ failed: 1, failedIds: [message.id] });
    expect(
      await prisma.outboxMessage.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({
      status: 'FAILED',
      attempts: MAX_SEND_ATTEMPTS,
      lastError: 'Resend 503: busy',
    });
  });

  it('raises an automation-failure attention item when a message cannot be delivered', async () => {
    const previous = { ...process.env };
    Object.assign(process.env, {
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 'k',
      EMAIL_FROM: 'ops@lab.dev',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'Invalid `to` field' }), {
        status: 422,
      })) as typeof fetch;
    try {
      await queue('broken@lab.dev');
      const output = await HANDLERS['outbox.dispatch'](
        {},
        { db: prisma, client: prisma, now: new Date() },
      );
      expect(output).toMatchObject({ provider: 'resend', failed: 1, simulated: false });
      const item = await prisma.attentionItem.findFirstOrThrow({
        where: { category: 'outbox.delivery_failed' },
      });
      expect(item.kind).toBe('AUTOMATION_FAILURE');
    } finally {
      globalThis.fetch = originalFetch;
      process.env = previous;
    }
  });
});

describe('Resend webhooks', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  async function sentMessage(to = 'ada@lab.dev') {
    const message = await queue(to);
    return prisma.outboxMessage.update({
      where: { id: message.id },
      data: { status: 'SENT', provider: 'resend', providerMessageId: 're_42' },
    });
  }

  it('records delivery, and applies a redelivered event only once', async () => {
    const message = await sentMessage();
    const event = { type: 'email.delivered', data: { email_id: 're_42' } };
    expect(await applyResendEvent(prisma, 'evt_1', event)).toBe('delivered');
    expect(await applyResendEvent(prisma, 'evt_1', event)).toBe('duplicate');
    const stored = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(stored.deliveredAt).not.toBeNull();
    expect(await prisma.webhookEvent.count()).toBe(1);
  });

  it('suppresses an address that bounces or complains', async () => {
    await sentMessage('Ada@Lab.dev');
    expect(
      await applyResendEvent(prisma, 'evt_2', {
        type: 'email.bounced',
        data: { email_id: 're_42' },
      }),
    ).toBe('bounced');
    expect(
      await prisma.emailSuppression.findUnique({ where: { email: 'ada@lab.dev' } }),
    ).toMatchObject({
      reason: 'BOUNCE',
    });
    // A complaint about the same address later does not duplicate the row.
    expect(
      await applyResendEvent(prisma, 'evt_3', {
        type: 'email.complained',
        data: { email_id: 're_42' },
      }),
    ).toBe('complained');
    expect(await prisma.emailSuppression.count()).toBe(1);
  });

  it('rejects unsigned requests at the route and accepts signed ones', async () => {
    await sentMessage();
    const key = Buffer.from('route-test-key');
    const previous = process.env.RESEND_WEBHOOK_SECRET;
    process.env.RESEND_WEBHOOK_SECRET = `whsec_${key.toString('base64')}`;
    try {
      const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 're_42' } });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', key)
        .update(`evt_9.${timestamp}.${body}`)
        .digest('base64');
      const request = (sig: string) =>
        new Request('http://localhost/api/webhooks/resend', {
          method: 'POST',
          headers: { 'svix-id': 'evt_9', 'svix-timestamp': timestamp, 'svix-signature': sig },
          body,
        });

      const forged = await resendWebhook(request('v1,forged') as any);
      expect(forged.status).toBe(401);
      const genuine = await resendWebhook(request(`v1,${signature}`) as any);
      expect(genuine.status).toBe(200);
      expect(await genuine.json()).toMatchObject({ outcome: 'delivered' });
    } finally {
      process.env.RESEND_WEBHOOK_SECRET = previous;
    }
  });
});

describe('Slack notifications', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  const config = { ...slackConfig({}), webhookUrl: 'https://hooks.slack.test/x' };

  async function raise(key: string, severity: 'LOW' | 'MEDIUM' | 'HIGH') {
    return raiseAttention(prisma, {
      dedupeKey: key,
      category: 'test',
      severity,
      title: `Item ${key}`,
      blocker: 'b',
      impact: 'i',
      nextAction: 'n',
    });
  }

  it('does nothing until a webhook is configured', async () => {
    await raise('a', 'HIGH');
    expect(await postAttentionToSlack(prisma)).toMatchObject({
      posted: 0,
      skipped: expect.any(String),
    });
  });

  it('posts each qualifying item once', async () => {
    await raise('low', 'LOW');
    await raise('med', 'MEDIUM');
    await raise('high', 'HIGH');
    const bodies: string[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return new Response('ok', { status: 200 });
    };

    expect(await postAttentionToSlack(prisma, { config, fetch: fetchImpl })).toEqual({ posted: 2 });
    expect(await postAttentionToSlack(prisma, { config, fetch: fetchImpl })).toEqual({ posted: 0 });
    expect(bodies.map((body) => JSON.parse(body).text)).toEqual([
      'Needs attention (medium): Item med',
      'Needs attention (high): Item high',
    ]);
  });

  it('leaves items unclaimed when Slack refuses, so the next run retries them', async () => {
    await raise('med', 'MEDIUM');
    const failing = async () => new Response('invalid_token', { status: 403 });
    await expect(
      prisma.$transaction((tx) => postAttentionToSlack(tx, { config, fetch: failing })),
    ).rejects.toThrow(/403/);
    const item = await prisma.attentionItem.findFirstOrThrow();
    expect(item.slackNotifiedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stripe payouts
// ---------------------------------------------------------------------------

class FakeGateway implements PayoutGateway {
  readonly mode = 'test' as const;
  accounts = 0;
  transfers: TransferRequest[] = [];
  private readonly seenKeys = new Map<string, string>();
  failFor = new Set<string>();

  async createAccount(input: { idempotencyKey: string }) {
    this.accounts += 1;
    return {
      id: `acct_${input.idempotencyKey}`,
      payoutsEnabled: false,
      requirementsDue: ['external_account'],
    };
  }
  async createOnboardingLink(input: { accountId: string }) {
    return `https://connect.stripe.test/setup/${input.accountId}`;
  }
  async createTransfer(input: TransferRequest) {
    const existing = this.seenKeys.get(input.idempotencyKey);
    if (existing) return { id: existing };
    if (this.failFor.has(input.destination))
      throw new Error('insufficient_funds: top up the test balance');
    this.transfers.push(input);
    const id = `tr_${this.transfers.length}`;
    this.seenKeys.set(input.idempotencyKey, id);
    return { id };
  }
}

async function approvedBatch(expertCount = 2) {
  const operator = await makeOperator({ name: 'Sam Operator' });
  const admin = await makeOperator({ role: 'ADMIN', name: 'Dana Admin' });
  const project = await makeProject(operator.id, {
    status: 'ACTIVE',
    seatsRequested: expertCount,
    maxHourlyRateCents: 30_000,
  });
  const experts = [];
  const itemIds: string[] = [];
  for (let index = 0; index < expertCount; index += 1) {
    const expert = await makeExpert({ status: 'VERIFIED', hourlyRateCents: 20_000 });
    const assignment = await makeConfirmedAssignment(project.id, expert.id, { rateCents: 20_000 });
    const workItem = await createWorkItem(prisma, actorFor(operator), {
      assignmentId: assignment.id,
      title: `Task ${index}`,
    });
    await submitWork(prisma, actorForExpert(expert), { workItemId: workItem.id, content: 'Done.' });
    await reviewWork(prisma, actorFor(operator), { workItemId: workItem.id, approve: true });
    const { item } = await draftPaymentFromApprovedWork(prisma, actorFor(operator), {
      workItemId: workItem.id,
    });
    itemIds.push(item.id);
    experts.push(expert);
  }
  const batch = await createBatch(prisma, actorFor(operator), {
    periodStart: new Date(Date.now() - 7 * 86_400_000),
    periodEnd: new Date(),
    itemIds,
  });
  await submitBatchForApproval(prisma, actorFor(operator), batch.id);
  await approveBatch(prisma, actorFor(admin), { batchId: batch.id });
  return { operator, admin, experts, batch, itemIds };
}

async function enablePayouts(expertId: string) {
  await prisma.expert.update({
    where: { id: expertId },
    data: { stripeAccountId: `acct_${expertId}`, payoutsEnabled: true },
  });
}

describe('payout onboarding', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('creates one connected account per expert and a fresh link each time', async () => {
    const expert = await makeExpert({ status: 'VERIFIED' });
    const gateway = new FakeGateway();
    const input = { expertId: expert.id, country: 'US', returnUrl: 'r', refreshUrl: 'f' };

    const first = await startPayoutOnboarding(prisma, gateway, actorForExpert(expert), input);
    const second = await startPayoutOnboarding(prisma, gateway, actorForExpert(expert), input);
    expect(gateway.accounts).toBe(1);
    expect(second.accountId).toBe(first.accountId);
    expect(first.url).toContain(first.accountId);
    const stored = await prisma.expert.findUniqueOrThrow({ where: { id: expert.id } });
    expect(stored).toMatchObject({
      payoutsEnabled: false,
      payoutRequirementsDue: ['external_account'],
    });
  });

  it('refuses to set up payouts for someone else', async () => {
    const expert = await makeExpert({ status: 'VERIFIED' });
    const other = await makeExpert({ status: 'VERIFIED' });
    await expectAppError(
      startPayoutOnboarding(prisma, new FakeGateway(), actorForExpert(other), {
        expertId: expert.id,
        country: 'US',
        returnUrl: 'r',
        refreshUrl: 'f',
      }),
      'FORBIDDEN',
    );
  });

  it('follows Stripe’s account state from webhooks', async () => {
    const expert = await makeExpert({ status: 'VERIFIED' });
    await prisma.expert.update({ where: { id: expert.id }, data: { stripeAccountId: 'acct_9' } });

    expect(
      await syncConnectedAccount(prisma, {
        id: 'acct_9',
        payoutsEnabled: true,
        requirementsDue: [],
      }),
    ).toMatchObject({
      matched: true,
      payoutsEnabled: true,
    });
    expect(
      await syncConnectedAccount(prisma, {
        id: 'acct_unknown',
        payoutsEnabled: true,
        requirementsDue: [],
      }),
    ).toEqual({
      matched: false,
    });
    expect(await prisma.activityEvent.count({ where: { action: 'payout.enabled' } })).toBe(1);
  });
});

describe('paying a batch', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('refuses to start while any expert cannot receive payouts', async () => {
    const { admin, experts, batch } = await approvedBatch();
    await enablePayouts(experts[0]!.id);
    const gateway = new FakeGateway();

    await expectAppError(
      payBatch(prisma, gateway, actorFor(admin), batch.id),
      'INVALID_STATE',
      /cannot receive payouts/,
    );
    expect(gateway.transfers).toHaveLength(0);
    expect((await prisma.paymentBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe(
      'APPROVED',
    );
  });

  it('pays every item once, with a key per item, and marks the batch paid', async () => {
    const { admin, experts, batch } = await approvedBatch();
    for (const expert of experts) await enablePayouts(expert.id);
    const gateway = new FakeGateway();

    const result = await payBatch(prisma, gateway, actorFor(admin), batch.id);
    expect(result).toMatchObject({ batchStatus: 'PAID', paid: 2, failed: [] });
    expect(gateway.transfers.map((transfer) => transfer.amountMinor)).toEqual([20_000, 20_000]);
    expect(new Set(gateway.transfers.map((transfer) => transfer.idempotencyKey)).size).toBe(2);
    const items = await prisma.paymentItem.findMany({ where: { batchId: batch.id } });
    expect(items.every((item) => item.status === 'PAID' && item.stripeTransferId)).toBe(true);

    // A second press does nothing: the batch is no longer payable.
    await expectAppError(payBatch(prisma, gateway, actorFor(admin), batch.id), 'INVALID_STATE');
    expect(gateway.transfers).toHaveLength(2);
  });

  it('finishes a partly failed batch on a later run without paying anyone twice', async () => {
    const { admin, experts, batch } = await approvedBatch();
    for (const expert of experts) await enablePayouts(expert.id);
    const gateway = new FakeGateway();
    gateway.failFor.add(`acct_${experts[1]!.id}`);

    const first = await payBatch(prisma, gateway, actorFor(admin), batch.id);
    expect(first).toMatchObject({ batchStatus: 'PAYING', paid: 1 });
    expect(first.failed[0]?.error).toMatch(/insufficient_funds/);

    gateway.failFor.clear();
    const second = await payBatch(prisma, gateway, actorFor(admin), batch.id);
    expect(second).toMatchObject({ batchStatus: 'PAID', paid: 1, alreadyPaid: 1 });
    expect(gateway.transfers).toHaveLength(2);
    const items = await prisma.paymentItem.findMany({ where: { batchId: batch.id } });
    expect(items.every((item) => item.payoutError === null)).toBe(true);
  });

  it('skips an expert whose payouts Stripe paused mid-batch, with a clear reason', async () => {
    const { admin, experts, batch } = await approvedBatch();
    for (const expert of experts) await enablePayouts(expert.id);
    const gateway = new FakeGateway();
    gateway.failFor.add(`acct_${experts[1]!.id}`);
    await payBatch(prisma, gateway, actorFor(admin), batch.id);

    await prisma.expert.update({ where: { id: experts[1]!.id }, data: { payoutsEnabled: false } });
    gateway.failFor.clear();
    const resumed = await payBatch(prisma, gateway, actorFor(admin), batch.id);
    expect(resumed.batchStatus).toBe('PAYING');
    expect(resumed.failed[0]?.error).toMatch(/paused by Stripe/);
    expect(gateway.transfers).toHaveLength(1);
  });

  it('keeps paid items out of new batches and out of corrections', async () => {
    const { operator, admin, experts, batch, itemIds } = await approvedBatch(1);
    await enablePayouts(experts[0]!.id);
    await payBatch(prisma, new FakeGateway(), actorFor(admin), batch.id);

    await expectAppError(
      createBatch(prisma, actorFor(operator), {
        periodStart: new Date(Date.now() - 86_400_000),
        periodEnd: new Date(),
        itemIds,
      }),
      'CONFLICT',
    );
    await expectAppError(
      correctPaymentItem(prisma, actorFor(operator), {
        paymentItemId: itemIds[0]!,
        quantity: '2',
        reason: 'Paid the wrong amount',
      }),
      'INVALID_STATE',
      /cannot be corrected here/,
    );
  });

  it('lets only an admin pay, and says what is missing when Stripe is not configured', async () => {
    const { operator, admin, batch } = await approvedBatch(1);
    const post = async (user: Awaited<ReturnType<typeof makeOperator>>) =>
      callRoute(
        batchAction,
        buildRequest('POST', `/api/payment-batches/${batch.id}`, {
          operatorToken: await operatorToken(user),
          body: { action: 'pay' },
        }),
        { batchId: batch.id },
      );

    expect((await post(operator)).status).toBe(403);
    const previous = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      const unconfigured = await post(admin);
      expect(unconfigured.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(unconfigured.body)).toMatch(/STRIPE_SECRET_KEY/);
    } finally {
      if (previous !== undefined) process.env.STRIPE_SECRET_KEY = previous;
    }
  });
});

afterEach(() => {
  // Nothing in this file may leave a real provider configured for later files.
  delete process.env.EMAIL_PROVIDER;
});

describe('what a real recipient reads', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('replaces the simulated-outbox footer when sending for real, and keeps the stored body', async () => {
    const { SIMULATED_FOOTER, DELIVERED_FOOTER } = await import('@/server/email/templates');
    const message = await queueMessage(prisma, {
      toEmail: 'ada@lab.dev',
      subject: 'Hi',
      bodyText: `Hello.\n--\n${SIMULATED_FOOTER}`,
      template: 'invitation.sent',
    });
    const texts: string[] = [];
    const provider: EmailProvider = {
      name: 'resend',
      async send(email) {
        texts.push(email.text);
        return { kind: 'sent', providerMessageId: 're_1' };
      },
    };
    await dispatchQueuedMessages(prisma, { provider, config: realConfig });
    expect(texts[0]).toContain(DELIVERED_FOOTER);
    expect(texts[0]).not.toContain('simulated outbox');
    const stored = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(stored.bodyText).toContain(SIMULATED_FOOTER);
  });
});
