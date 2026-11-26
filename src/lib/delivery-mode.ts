/**
 * How messages leave this system.
 *
 * By default they do not: every "email" is a row in `OutboxMessage` that the
 * worker marks delivered, and `SENT` means only that. With
 * `EMAIL_PROVIDER=resend` (docs/integrations.md) the worker sends them for
 * real, and the "not emailed" labels across the app disappear.
 *
 * This is a single named fact rather than a sentence repeated on each screen,
 * so every screen changes together. It reads the environment directly, not
 * through the provider module, so it is safe to import anywhere; in a browser
 * bundle the variable is absent and the answer is the cautious one.
 */
export type DeliveryMode = 'simulated' | 'external';

export function deliveryMode(): DeliveryMode {
  return process.env.EMAIL_PROVIDER === 'resend' ? 'external' : 'simulated';
}

export const SIMULATED_DELIVERY_NOTE =
  'Written to the in-app outbox. No mail server is configured, so nothing was delivered to anyone.';

/** The short form, for a badge or a tooltip. */
export const SIMULATED_DELIVERY_SHORT = 'Simulated: nothing was emailed.';
