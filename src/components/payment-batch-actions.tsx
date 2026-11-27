'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { CSRF_COOKIE, CSRF_HEADER } from '@/lib/csrf-constants';
import { Alert } from '@/components/ui';

/** What the page knows about paying this batch by Stripe transfer. */
export interface BatchPayout {
  /** The signed-in user holds `payment:payout`. */
  allowed: boolean;
  /** Why Stripe cannot be used at all, or null when it can. */
  unavailableReason: string | null;
  /** Experts in the batch who cannot receive payouts yet. */
  notReady: string[];
  totalLabel: string;
  itemCount: number;
}

interface PayResult {
  batchStatus: 'PAYING' | 'PAID';
  paid: number;
  alreadyPaid: number;
  failed: Array<{ reference: string; error: string }>;
}

/**
 * Batch lifecycle buttons.
 *
 * Approval is deliberately unavailable to the operator who created the batch;
 * the server refuses it, and the error is shown rather than the button being
 * hidden, so the reason is visible.
 */
export function PaymentBatchActions({
  batchId,
  reference,
  status,
  canApprove,
  canWrite,
  payout,
}: {
  batchId: string;
  reference: string;
  status: string;
  canApprove: boolean;
  canWrite: boolean;
  payout?: BatchPayout;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingPay, setConfirmingPay] = useState(false);
  const [payResult, setPayResult] = useState<PayResult | null>(null);

  const canOfferPay = Boolean(payout?.allowed) && (status === 'APPROVED' || status === 'PAYING');
  const payBlocked =
    payout?.unavailableReason ??
    (status === 'APPROVED' && payout && payout.notReady.length > 0
      ? `${payout.notReady.join(', ')} cannot receive payouts yet.`
      : null);

  async function pay() {
    setPending(true);
    setError(null);
    const result = await apiPost<PayResult>(`/api/payment-batches/${batchId}`, { action: 'pay' });
    setPending(false);
    setConfirmingPay(false);
    if (!result.ok || !result.data) {
      setError(result.error?.message ?? 'The batch could not be paid.');
      return;
    }
    setPayResult(result.data);
    router.refresh();
  }

  async function act(action: 'submit' | 'approve') {
    setPending(true);
    setError(null);
    const result = await apiPost(`/api/payment-batches/${batchId}`, { action });
    setPending(false);
    if (!result.ok) {
      setError(result.error?.message ?? 'That could not be completed.');
      return;
    }
    router.refresh();
  }

  /**
   * Export returns CSV rather than JSON, so it is fetched directly and turned
   * into a download. The CSRF header is attached the same way apiFetch does.
   */
  async function exportBatch() {
    setPending(true);
    setError(null);
    try {
      const token = document.cookie
        .split(';')
        .map((part) => part.trim().split('='))
        .find(([key]) => key === CSRF_COOKIE)?.[1];

      const response = await fetch(`/api/payment-batches/${batchId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { [CSRF_HEADER]: decodeURIComponent(token) } : {}),
        },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'export' }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? 'The export failed.');
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${reference.toLowerCase()}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap gap-2">
        {canWrite && status === 'DRAFT' && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={pending}
            onClick={() => act('submit')}
          >
            Submit for approval
          </button>
        )}
        {status === 'PENDING_APPROVAL' && canApprove && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={pending}
            onClick={() => act('approve')}
          >
            Approve
          </button>
        )}
        {status === 'APPROVED' && canApprove && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={pending}
            onClick={exportBatch}
          >
            Export CSV
          </button>
        )}
        {canOfferPay && !confirmingPay && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={pending || payBlocked !== null}
            title={payBlocked ?? undefined}
            onClick={() => {
              setPayResult(null);
              setConfirmingPay(true);
            }}
          >
            {status === 'PAYING' ? 'Resume Stripe payment' : 'Pay with Stripe (test mode)'}
          </button>
        )}
        {status === 'EXPORTED' && (
          <span className="text-xs text-ink-500">Exported. Not a record of payment.</span>
        )}
      </div>

      {/* Experts who are not ready are named beside the batch already; only a
          Stripe-wide reason needs saying here. */}
      {canOfferPay && payout?.unavailableReason && !confirmingPay && (
        <p className="max-w-xs text-right text-xs text-ink-500">{payout.unavailableReason}</p>
      )}

      {confirmingPay && payout && (
        <div
          role="group"
          aria-label={`Confirm paying ${reference}`}
          className="w-full max-w-sm space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-left sm:w-80"
        >
          <p className="text-sm font-semibold text-ink-900">
            {status === 'PAYING'
              ? `Send the remaining transfers for ${reference}?`
              : `Pay ${payout.totalLabel} across ${payout.itemCount} item${payout.itemCount === 1 ? '' : 's'}?`}
          </p>
          <p className="text-xs text-amber-900">
            One Stripe transfer per item, in <strong>test mode</strong>: only test money moves. Once
            paying starts the batch cannot be exported or cancelled, and each item is paid at most
            once.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={pending}
              onClick={pay}
            >
              {pending ? 'Sending transfers…' : 'Confirm: pay with Stripe'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={pending}
              onClick={() => setConfirmingPay(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {payResult && (
        <div className="w-full max-w-sm sm:w-80">
          <Alert tone={payResult.failed.length > 0 ? 'warning' : 'success'}>
            {payResult.batchStatus === 'PAID' ? 'Batch paid. ' : 'Batch partly paid. '}
            {payResult.paid} transfer{payResult.paid === 1 ? '' : 's'} sent
            {payResult.alreadyPaid > 0 ? `, ${payResult.alreadyPaid} already paid` : ''}
            {payResult.failed.length > 0 ? `, ${payResult.failed.length} failed` : ''}.
            {payResult.failed.length > 0 && (
              <span className="mt-1 block">
                {payResult.failed.map((failure) => (
                  <span key={failure.reference} className="block">
                    <span className="font-mono">{failure.reference}</span>: {failure.error}
                  </span>
                ))}
                Resume payment to retry them.
              </span>
            )}
          </Alert>
        </div>
      )}

      {error && (
        <p role="alert" className="max-w-xs rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}
