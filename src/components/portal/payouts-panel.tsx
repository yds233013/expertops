'use client';

import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Alert, Badge, Card } from '@/components/ui';

export type PortalPayoutState = 'not_set_up' | 'incomplete' | 'ready';

/**
 * The expert's own payout setup.
 *
 * Setup happens on Stripe's hosted pages: this button only asks for a fresh,
 * short-lived link and sends the browser there. Stripe sends them back to
 * `/portal?payouts=returned`, or `?payouts=expired` if the link lapsed.
 */
export function PayoutsPanel({
  state,
  missing,
  notice,
}: {
  state: PortalPayoutState;
  /** Plain-language lines, already translated from Stripe's keys. */
  missing: string[];
  notice: 'returned' | 'expired' | null;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    const result = await apiPost<{ url: string }>('/api/portal/payouts');
    if (!result.ok || !result.data?.url) {
      setPending(false);
      setError(result.error?.message ?? 'Payout setup could not be started. Try again shortly.');
      return;
    }
    // Stays "pending" while the browser leaves for Stripe.
    window.location.assign(result.data.url);
  }

  const badge =
    state === 'ready' ? (
      <Badge tone="success">ready to be paid</Badge>
    ) : state === 'incomplete' ? (
      <Badge tone="warning">setup incomplete</Badge>
    ) : (
      <Badge tone="muted">not set up</Badge>
    );

  return (
    <Card
      title="Get paid"
      description="Payouts are sent through Stripe. Your bank and tax details go to Stripe directly; ExpertOps never sees them."
      actions={badge}
    >
      <div className="space-y-3">
        {notice === 'returned' && state !== 'ready' && (
          <Alert tone="info">
            Thanks — Stripe is confirming your details; this can take a minute. Reload this page to
            see the latest status.
          </Alert>
        )}
        {notice === 'returned' && state === 'ready' && (
          <Alert tone="success">Thanks — your payout setup is complete.</Alert>
        )}
        {notice === 'expired' && (
          <Alert tone="warning">That link expired, start again. Your progress is saved.</Alert>
        )}

        {state === 'ready' && (
          <p className="text-sm text-ink-700">
            You are set up. Approved work is paid to the account you gave Stripe. To change your
            bank account, open your setup again.
          </p>
        )}
        {state === 'not_set_up' && (
          <p className="text-sm text-ink-700">
            Set up payouts once to be paid for approved work. It takes about five minutes on
            Stripe&rsquo;s secure pages: you will need your bank details and, in some countries, a
            tax number.
          </p>
        )}
        {state === 'incomplete' && (
          <div className="space-y-2">
            <p className="text-sm text-ink-700">Stripe still needs a few things from you:</p>
            {missing.length > 0 ? (
              <ul className="space-y-1">
                {missing.map((line) => (
                  <li
                    key={line}
                    className="flex items-center gap-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-sm text-amber-900"
                  >
                    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                    <span className="break-anywhere">{line}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-ink-500">
                Stripe is still reviewing what you sent. Check back shortly.
              </p>
            )}
          </div>
        )}

        {error && <Alert tone="error">{error}</Alert>}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={state === 'ready' ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}
            disabled={pending}
            onClick={start}
          >
            {pending
              ? 'Opening Stripe…'
              : state === 'not_set_up'
                ? 'Set up payouts'
                : state === 'incomplete'
                  ? 'Finish payout setup'
                  : 'Review payout details'}
          </button>
          <span className="text-xs text-ink-500">
            Opens Stripe. Test mode: no real money moves in this workspace.
          </span>
        </div>
      </div>
    </Card>
  );
}
