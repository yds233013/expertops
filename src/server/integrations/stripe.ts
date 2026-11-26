import Stripe from 'stripe';
import { invalidState } from '@/lib/errors';

/**
 * Stripe Connect, through one narrow interface.
 *
 * The rest of the application talks to `PayoutGateway`, never to the SDK, so
 * the test suite can run every payout path against a fake and nothing here can
 * reach Stripe by accident.
 *
 * **Test mode only.** `stripeConfig` refuses any key that is not a test key.
 * Paying real people needs contracts, tax forms, a funded balance and a legal
 * entity this demo does not have, and a misplaced live key must not be able to
 * move money.
 */
export interface ConnectedAccountState {
  id: string;
  payoutsEnabled: boolean;
  requirementsDue: string[];
}

export interface TransferRequest {
  amountMinor: number;
  currency: string;
  destination: string;
  /** Groups a batch's transfers in the Stripe dashboard. */
  group: string;
  description: string;
  metadata: Record<string, string>;
  /** Same key, same transfer: a retry can never pay twice. */
  idempotencyKey: string;
}

export interface PayoutGateway {
  readonly mode: 'test';
  createAccount(input: {
    email: string;
    country: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<ConnectedAccountState>;
  createOnboardingLink(input: {
    accountId: string;
    returnUrl: string;
    refreshUrl: string;
  }): Promise<string>;
  createTransfer(input: TransferRequest): Promise<{ id: string }>;
}

export interface StripeConfig {
  secretKey: string | null;
  webhookSecret: string | null;
  country: string;
}

export class StripeConfigError extends Error {}

export function stripeConfig(env: Record<string, string | undefined> = process.env): StripeConfig {
  const secretKey = env.STRIPE_SECRET_KEY?.trim() || null;
  if (secretKey && !/^(sk|rk)_test_/.test(secretKey)) {
    throw invalidState(
      'STRIPE_SECRET_KEY is not a test-mode key. This build only moves test money.',
    );
  }
  return {
    secretKey,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() || null,
    country: (env.STRIPE_CONNECT_COUNTRY?.trim() || 'US').toUpperCase(),
  };
}

export function accountState(account: Stripe.Account): ConnectedAccountState {
  return {
    id: account.id,
    payoutsEnabled: Boolean(account.payouts_enabled),
    requirementsDue: account.requirements?.currently_due ?? [],
  };
}

export class StripePayoutGateway implements PayoutGateway {
  readonly mode = 'test' as const;
  private readonly stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
  }

  async createAccount(input: {
    email: string;
    country: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<ConnectedAccountState> {
    const account = await this.stripe.accounts.create(
      {
        type: 'express',
        country: input.country,
        email: input.email,
        business_type: 'individual',
        capabilities: { transfers: { requested: true } },
        metadata: input.metadata,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return accountState(account);
  }

  async createOnboardingLink(input: {
    accountId: string;
    returnUrl: string;
    refreshUrl: string;
  }): Promise<string> {
    const link = await this.stripe.accountLinks.create({
      account: input.accountId,
      type: 'account_onboarding',
      return_url: input.returnUrl,
      refresh_url: input.refreshUrl,
    });
    return link.url;
  }

  async createTransfer(input: TransferRequest): Promise<{ id: string }> {
    const transfer = await this.stripe.transfers.create(
      {
        amount: input.amountMinor,
        currency: input.currency.toLowerCase(),
        destination: input.destination,
        transfer_group: input.group,
        description: input.description,
        metadata: input.metadata,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { id: transfer.id };
  }
}

/** The configured gateway, or an explanation of what is missing. */
export function payoutGateway(config: StripeConfig = stripeConfig()): PayoutGateway {
  if (!config.secretKey) {
    throw invalidState(
      'Payouts are not configured: set STRIPE_SECRET_KEY to a test-mode key. Exporting the batch as a file still works.',
    );
  }
  return new StripePayoutGateway(config.secretKey);
}

/**
 * Verify and parse a Stripe webhook. Uses the SDK's own check, which covers
 * the signature scheme and the timestamp tolerance.
 */
export function constructStripeEvent(
  body: string,
  signature: string | null,
  webhookSecret: string,
): Stripe.Event {
  if (!signature) throw new StripeConfigError('Missing stripe-signature header.');
  return Stripe.webhooks.constructEvent(body, signature, webhookSecret);
}

/** A message safe to show an operator, from whatever the SDK threw. */
export function describeStripeError(error: unknown): string {
  if (error instanceof Stripe.errors.StripeError) {
    return `${error.type}${error.code ? ` (${error.code})` : ''}: ${error.message}`;
  }
  return error instanceof Error ? error.message : 'Unknown error from Stripe.';
}
