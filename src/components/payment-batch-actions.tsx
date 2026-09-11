'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { CSRF_COOKIE, CSRF_HEADER } from '@/lib/csrf-constants';

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
}: {
  batchId: string;
  reference: string;
  status: string;
  canApprove: boolean;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        {status === 'EXPORTED' && (
          <span className="text-xs text-ink-500">Exported. Not a record of payment.</span>
        )}
      </div>
      {error && (
        <p role="alert" className="max-w-xs rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}
