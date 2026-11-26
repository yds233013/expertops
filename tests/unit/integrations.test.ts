import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  emailConfig,
  emailProviderFor,
  EmailConfigError,
  recipientBlockReason,
  ResendEmailProvider,
} from '@/server/email/provider';
import { verifySvixSignature, WebhookSignatureError } from '@/server/integrations/webhooks';
import { attentionMessage, severitiesAtLeast, slackConfig } from '@/server/integrations/slack';
import { AppError } from '@/lib/errors';
import { stripeConfig } from '@/server/integrations/stripe';

const email = {
  id: 'msg_1',
  to: 'ada@lab.dev',
  toName: 'Ada Example',
  subject: 'Hi',
  text: 'Body',
};

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
  return { impl, calls };
}

describe('Resend provider', () => {
  it('sends with an idempotency key derived from the outbox id', async () => {
    const { impl, calls } = fakeFetch(200, { id: 're_123' });
    const provider = new ResendEmailProvider({ apiKey: 'k', from: 'ops@lab.dev', fetch: impl });

    expect(await provider.send(email)).toEqual({ kind: 'sent', providerMessageId: 're_123' });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('outbox-msg_1');
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      from: 'ops@lab.dev',
      to: ['Ada Example <ada@lab.dev>'],
      subject: 'Hi',
      text: 'Body',
    });
  });

  it('retries rate limits, server errors and idempotency races', async () => {
    for (const status of [429, 409, 500, 503]) {
      const { impl } = fakeFetch(status, { message: 'nope' });
      const outcome = await new ResendEmailProvider({ apiKey: 'k', from: 'f', fetch: impl }).send(
        email,
      );
      expect(outcome.kind, String(status)).toBe('retry');
    }
  });

  it('gives up on a request the provider rejects', async () => {
    const { impl } = fakeFetch(422, { name: 'validation_error', message: 'Invalid `to` field' });
    const outcome = await new ResendEmailProvider({ apiKey: 'k', from: 'f', fetch: impl }).send(
      email,
    );
    expect(outcome).toEqual({ kind: 'failed', error: 'Resend 422: Invalid `to` field' });
  });

  it('retries when the network fails', async () => {
    const impl = async () => {
      throw new Error('ECONNRESET');
    };
    const outcome = await new ResendEmailProvider({ apiKey: 'k', from: 'f', fetch: impl }).send(
      email,
    );
    expect(outcome.kind).toBe('retry');
  });

  it('names the missing setting instead of failing obscurely', () => {
    expect(() => emailProviderFor(emailConfig({ EMAIL_PROVIDER: 'resend' }))).toThrow(
      EmailConfigError,
    );
    expect(() =>
      emailProviderFor(emailConfig({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k' })),
    ).toThrow(/EMAIL_FROM/);
    expect(emailProviderFor(emailConfig({})).name).toBe('simulated');
  });
});

describe('recipient guard', () => {
  const open = emailConfig({});
  it('never sends to reserved test domains', () => {
    for (const address of [
      'a@example.test',
      'a@x.example',
      'a@example.com',
      'a@foo.invalid',
      'a@localhost',
    ]) {
      expect(recipientBlockReason(address, open), address).toMatch(/reserved/);
    }
    expect(recipientBlockReason('a@lab.dev', open)).toBeNull();
  });

  it('applies the allow-list when one is set', () => {
    const config = emailConfig({ EMAIL_ALLOWED_DOMAINS: 'lab.dev, Partner.org' });
    expect(recipientBlockReason('a@LAB.dev', config)).toBeNull();
    expect(recipientBlockReason('a@partner.org', config)).toBeNull();
    expect(recipientBlockReason('a@gmail.com', config)).toMatch(/not in EMAIL_ALLOWED_DOMAINS/);
  });
});

describe('Svix webhook signatures', () => {
  const secret = `whsec_${Buffer.from('super-secret-key').toString('base64')}`;
  const now = new Date('2026-11-26T12:00:00Z');
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const body = '{"type":"email.delivered"}';
  const sign = (content: string) =>
    createHmac('sha256', Buffer.from('super-secret-key')).update(content).digest('base64');

  it('accepts a valid signature, including one of several during rotation', () => {
    const good = `v1,${sign(`evt_1.${timestamp}.${body}`)}`;
    expect(() =>
      verifySvixSignature({
        secret,
        id: 'evt_1',
        timestamp,
        signature: `v1,bogus ${good}`,
        body,
        now,
      }),
    ).not.toThrow();
  });

  it('refuses a tampered body, a missing header and an old timestamp', () => {
    const signature = `v1,${sign(`evt_1.${timestamp}.${body}`)}`;
    expect(() =>
      verifySvixSignature({ secret, id: 'evt_1', timestamp, signature, body: `${body} `, now }),
    ).toThrow(WebhookSignatureError);
    expect(() =>
      verifySvixSignature({ secret, id: null, timestamp, signature, body, now }),
    ).toThrow(/Missing/);
    const later = new Date(now.getTime() + 10 * 60_000);
    expect(() =>
      verifySvixSignature({ secret, id: 'evt_1', timestamp, signature, body, now: later }),
    ).toThrow(/window/);
  });
});

describe('Slack', () => {
  it('is off until a webhook URL is set and defaults to medium and above', () => {
    expect(slackConfig({}).webhookUrl).toBeNull();
    expect(severitiesAtLeast(slackConfig({}).minSeverity)).toEqual(['MEDIUM', 'HIGH']);
    expect(severitiesAtLeast(slackConfig({ SLACK_MIN_SEVERITY: 'HIGH' }).minSeverity)).toEqual([
      'HIGH',
    ]);
  });

  it('escapes text so a title cannot inject Slack markup or links', () => {
    const message = attentionMessage(
      {
        title: 'Review <!channel> & <https://evil.example|click>',
        blocker: 'x',
        nextAction: 'y',
        severity: 'HIGH',
        kind: 'BUSINESS_BLOCKER',
      },
      'https://ops.example',
    );
    const section = JSON.stringify(message.blocks[0]);
    expect(section).not.toContain('<!channel>');
    expect(section).toContain('&lt;!channel&gt; &amp;');
    expect(JSON.stringify(message.blocks[1])).toContain('<https://ops.example/attention|');
  });
});

describe('Stripe configuration', () => {
  it('accepts only test-mode keys', () => {
    expect(stripeConfig({ STRIPE_SECRET_KEY: 'sk_test_abc' }).secretKey).toBe('sk_test_abc');
    expect(stripeConfig({ STRIPE_SECRET_KEY: 'rk_test_abc' }).secretKey).toBe('rk_test_abc');
    expect(() => stripeConfig({ STRIPE_SECRET_KEY: 'sk_live_abc' })).toThrow(AppError);
    expect(stripeConfig({}).secretKey).toBeNull();
    expect(stripeConfig({ STRIPE_CONNECT_COUNTRY: 'gb' }).country).toBe('GB');
  });
});
