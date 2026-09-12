'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

export interface DispatchOutcome {
  dispatched: number;
  skipped: Array<{ expertId: string; reason: string }>;
  failed: Array<{ expertId: string; error: string }>;
  takenByAnotherRequest: number;
  alreadySent: number;
  /** Authoritative recipient states, read back from the database. */
  totals: { sent: number; skipped: number; failed: number; pending: number };
  complete: boolean;
}

/**
 * The approval and dispatch controls for one batch.
 *
 * Each button is shown only in the state where it applies and only to a role
 * that holds the capability, but the server decides either way: the same rules
 * refuse the request if the button is reached another way.
 */
export function OutreachBatchActions({
  batchId,
  status,
  retryable,
  canWrite,
  canApprove,
}: {
  batchId: string;
  status: string;
  /** Recipients a dispatch would act on right now. */
  retryable: number;
  canWrite: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<DispatchOutcome | null>(null);

  async function send(body: Record<string, unknown>, label: string) {
    setPending(label);
    setError(null);
    try {
      const result = await apiPost<DispatchOutcome>(`/api/outreach-batches/${batchId}`, body);
      if (!result.ok) {
        setError(result.error?.message ?? 'That could not be done.');
        return;
      }
      if (label === 'dispatch') setOutcome(result.data ?? null);
      setNote('');
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  const canDispatch = ['APPROVED', 'PARTIALLY_DISPATCHED'].includes(status) && retryable > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {status === 'DRAFT' && canWrite && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={pending !== null}
            onClick={() => send({ action: 'submit' }, 'submit')}
          >
            {pending === 'submit' ? 'Submitting…' : 'Submit for approval'}
          </button>
        )}

        {status === 'PENDING_APPROVAL' && canApprove && (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={pending !== null}
              onClick={() => send({ action: 'decide', approve: true, note }, 'approve')}
            >
              {pending === 'approve' ? 'Approving…' : 'Approve'}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={pending !== null || !note.trim()}
              onClick={() => send({ action: 'decide', approve: false, note }, 'reject')}
            >
              {pending === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
          </>
        )}

        {status === 'PENDING_APPROVAL' && !canApprove && (
          <p className="text-xs text-ink-600">
            Waiting on an operator who holds the approval capability. Your role can assemble and
            submit batches but not approve them.
          </p>
        )}

        {canDispatch && canApprove && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={pending !== null}
            onClick={() => send({ action: 'dispatch' }, 'dispatch')}
          >
            {pending === 'dispatch'
              ? 'Dispatching…'
              : status === 'PARTIALLY_DISPATCHED'
                ? `Retry ${retryable} recipient${retryable === 1 ? '' : 's'}`
                : `Dispatch to ${retryable} recipient${retryable === 1 ? '' : 's'}`}
          </button>
        )}
      </div>

      {status === 'PENDING_APPROVAL' && canApprove && (
        <div>
          <label htmlFor={`note-${batchId}`} className="text-xs font-semibold text-ink-700">
            Note (required to reject)
          </label>
          <textarea
            id={`note-${batchId}`}
            rows={2}
            className="input mt-1 w-full"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      )}

      {outcome && (
        <div role="status" className="rounded-md bg-ink-50 px-3 py-2 text-sm text-ink-800">
          <p>
            This request created {outcome.dispatched} invitation(s), permanently skipped{' '}
            {outcome.skipped.length}, and left {outcome.failed.length} retryable.
          </p>
          <p className="mt-1 text-xs text-ink-600">
            The batch now stands at {outcome.totals.sent} sent, {outcome.totals.skipped} skipped,{' '}
            {outcome.totals.failed + outcome.totals.pending} outstanding.
            {outcome.takenByAnotherRequest > 0 &&
              ` ${outcome.takenByAnotherRequest} recipient(s) were settled by another request running at the same time.`}
          </p>
          {!outcome.complete && (
            <p className="mt-1 text-xs text-amber-900">
              The batch is not finished. The retryable recipients are still listed below and
              dispatching again picks up exactly those.
            </p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}
