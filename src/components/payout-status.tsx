import { formatDateTime, formatRelative } from '@/lib/time';
import { payoutRequirements, payoutState } from '@/lib/payout-requirements';
import { Badge, Card } from '@/components/ui';

export interface PayoutFields {
  stripeAccountId: string | null;
  payoutsEnabled: boolean;
  payoutRequirementsDue: unknown;
  payoutStatusUpdatedAt: Date | null;
}

/** One badge for where an expert's payout setup stands. */
export function PayoutStateBadge({ expert }: { expert: PayoutFields }) {
  const state = payoutState(expert);
  if (state === 'ready') return <Badge tone="success">can receive payouts</Badge>;
  if (state === 'incomplete') return <Badge tone="warning">setup incomplete</Badge>;
  return <Badge tone="muted">not set up</Badge>;
}

/**
 * The operator's view of an expert's Stripe payout account.
 *
 * Mirrors what Stripe last reported by webhook. Nothing here is a guess: if
 * Stripe has not said payouts are enabled, they are not.
 */
export function ExpertPayoutPanel({ expert }: { expert: PayoutFields }) {
  const state = payoutState(expert);
  const missing = payoutRequirements(expert.payoutRequirementsDue);

  return (
    <Card
      title="Payouts"
      description="Stripe Connect, test mode. Bank and tax details stay with Stripe; this workspace never sees them."
      actions={<PayoutStateBadge expert={expert} />}
    >
      {state === 'not_set_up' && (
        <p className="text-sm text-ink-600">
          This expert has not started payout setup. They do it themselves from{' '}
          <strong className="font-semibold text-ink-800">Get paid</strong> in their portal. Until
          then, batches that include them can be exported but not paid by transfer.
        </p>
      )}

      {state === 'incomplete' && (
        <div className="space-y-2">
          <p className="text-sm text-ink-700">
            Stripe needs more before it will send money to this expert.
          </p>
          {missing.length > 0 ? (
            <ul className="space-y-1">
              {missing.map((line) => (
                <li
                  key={line}
                  className="flex items-center gap-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900"
                >
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  <span className="break-anywhere">{line}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-500">
              Stripe has not listed anything specific yet. It may still be reviewing their details.
            </p>
          )}
          <p className="text-xs text-ink-500">
            Only the expert can provide these, in their portal.
          </p>
        </div>
      )}

      {state === 'ready' && (
        <p className="text-sm text-ink-700">
          Stripe can send transfers to this expert. Batches that include them can be paid.
        </p>
      )}

      {expert.stripeAccountId && (
        <dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-ink-100 pt-3 text-xs">
          <dt className="font-semibold text-ink-500">Account</dt>
          <dd className="font-mono text-ink-800 break-anywhere">{expert.stripeAccountId}</dd>
          <dt className="font-semibold text-ink-500">Last update</dt>
          <dd className="text-ink-700" title={formatDateTime(expert.payoutStatusUpdatedAt)}>
            {expert.payoutStatusUpdatedAt
              ? `${formatRelative(expert.payoutStatusUpdatedAt)}, from Stripe`
              : 'Never'}
          </dd>
        </dl>
      )}
    </Card>
  );
}
