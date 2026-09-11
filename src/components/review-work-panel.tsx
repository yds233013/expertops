'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

const DIMENSIONS = ['accuracy', 'completeness', 'clarity', 'methodology'] as const;

/**
 * HUMAN DECISION. Review one submission.
 *
 * The approved quantity is what payment preparation reads, so it is shown
 * explicitly alongside what the expert claimed rather than defaulting silently.
 */
export function ReviewWorkPanel({
  workItemId,
  reference,
  basis,
  claimedQuantity,
}: {
  workItemId: string;
  reference: string;
  basis: string;
  claimedQuantity: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [approvedQuantity, setApprovedQuantity] = useState(claimedQuantity ?? '1');
  const [summary, setSummary] = useState('');
  const [revisionRequest, setRevisionRequest] = useState('');
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<'approve' | 'revise' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Review {reference}
      </button>
    );
  }

  async function decide(approve: boolean) {
    setPending(approve ? 'approve' : 'revise');
    setError(null);

    const cleaned = Object.fromEntries(
      Object.entries(feedback).filter(([, value]) => value.trim().length > 0),
    );

    const result = await apiPost(`/api/work-items/${workItemId}`, {
      approve,
      summary: summary.trim() || undefined,
      feedback: Object.keys(cleaned).length > 0 ? cleaned : undefined,
      revisionRequest: approve ? undefined : revisionRequest.trim(),
      approvedQuantity: approve ? approvedQuantity : undefined,
    });
    setPending(null);

    if (!result.ok) {
      setError(result.error?.message ?? 'The review could not be recorded.');
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="w-80 space-y-2 rounded-lg border border-ink-200 bg-white p-3">
      <p className="text-xs font-semibold text-ink-800">Review {reference}</p>

      <div>
        <label className="label" htmlFor={`summary-${workItemId}`}>
          Summary
        </label>
        <textarea
          id={`summary-${workItemId}`}
          className="textarea"
          rows={2}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
        />
      </div>

      <fieldset className="space-y-1">
        <legend className="label">Structured feedback</legend>
        {DIMENSIONS.map((dimension) => (
          <div key={dimension}>
            <label className="sr-only" htmlFor={`${dimension}-${workItemId}`}>
              {dimension}
            </label>
            <input
              id={`${dimension}-${workItemId}`}
              className="input"
              placeholder={dimension}
              value={feedback[dimension] ?? ''}
              onChange={(event) =>
                setFeedback((current) => ({ ...current, [dimension]: event.target.value }))
              }
            />
          </div>
        ))}
      </fieldset>

      <div>
        <label className="label" htmlFor={`quantity-${workItemId}`}>
          Approved {basis === 'HOURLY' ? 'hours' : 'quantity'}
          {claimedQuantity ? ` (claimed ${claimedQuantity})` : ''}
        </label>
        <input
          id={`quantity-${workItemId}`}
          className="input"
          inputMode="decimal"
          value={approvedQuantity}
          onChange={(event) => setApprovedQuantity(event.target.value)}
        />
        <p className="mt-1 text-[0.7rem] text-ink-500">
          Approving fewer than claimed is allowed. The difference is flagged on the payment item for
          someone to explain.
        </p>
      </div>

      <div>
        <label className="label" htmlFor={`revision-${workItemId}`}>
          What to change (required to request a revision)
        </label>
        <textarea
          id={`revision-${workItemId}`}
          className="textarea"
          rows={2}
          value={revisionRequest}
          onChange={(event) => setRevisionRequest(event.target.value)}
        />
      </div>

      {error && (
        <p role="alert" className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={pending !== null}
          onClick={() => decide(true)}
        >
          {pending === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={pending !== null || revisionRequest.trim().length === 0}
          onClick={() => decide(false)}
        >
          {pending === 'revise' ? 'Saving…' : 'Request revision'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
