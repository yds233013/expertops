/**
 * How messages leave this system. They do not.
 *
 * Every "email" is a row in `OutboxMessage` that the worker marks delivered.
 * There is no mail transport configured, no credentials for one, and no code
 * that opens a connection to one. `SENT` on an outbox row means "the worker
 * marked this row delivered", and `SENT` on an invitation means "a simulated
 * message was queued for it" — neither means a person received anything.
 *
 * This is a single named fact rather than a sentence repeated on each screen,
 * so the day a real transport is added there is exactly one place that changes
 * and every screen changes with it.
 */
export type DeliveryMode = 'simulated' | 'external';

export function deliveryMode(): DeliveryMode {
  // Deliberately not configurable. Returning 'external' would require a
  // transport to exist, and none does; see docs/pilot-readiness.md.
  return 'simulated';
}

export const SIMULATED_DELIVERY_NOTE =
  'Written to the in-app outbox. No mail server is configured, so nothing was delivered to anyone.';

/** The short form, for a badge or a tooltip. */
export const SIMULATED_DELIVERY_SHORT = 'Simulated: nothing was emailed.';
