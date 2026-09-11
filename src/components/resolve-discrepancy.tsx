'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

/**
 * HUMAN DECISION. Explain a payment discrepancy, or correct the figure.
 *
 * An explanation clears the flag and leaves the amount alone. A correction
 * supersedes the item, keeps the original on file, and invalidates any approval
 * that covered the old number.
 */
export function ResolveDiscrepancy({
  paymentItemId,
  reference,
}: {
  paymentItemId: string;
  reference: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'explain' | 'correct'>('explain');
  const [text, setText] = useState('');
  const [quantity, setQuantity] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!text.trim()) {
      setError('An explanation is required so the decision is on the record.');
      return;
    }
    setPending(true);
    setError(null);

    const result =
      mode === 'explain'
        ? await apiPost(`/api/payment-items/${paymentItemId}`, {
            action: 'resolve_discrepancy',
            resolution: text.trim(),
          })
        : await apiPost(`/api/payment-items/${paymentItemId}`, {
            action: 'correct',
            quantity,
            reason: text.trim(),
          });

    setPending(false);
    if (!result.ok) {
      setError(result.error?.message ?? 'That could not be recorded.');
      return;
    }
    setText('');
    setQuantity('');
    router.refresh();
  }

  return (
    <div className="w-72 space-y-2">
      <div className="flex gap-2 text-xs">
        <button
          type="button"
          className={mode === 'explain' ? 'font-semibold text-accent-600' : 'text-ink-500'}
          onClick={() => setMode('explain')}
        >
          Explain
        </button>
        <span className="text-ink-300">|</span>
        <button
          type="button"
          className={mode === 'correct' ? 'font-semibold text-accent-600' : 'text-ink-500'}
          onClick={() => setMode('correct')}
        >
          Correct the figure
        </button>
      </div>

      {mode === 'correct' && (
        <div>
          <label className="sr-only" htmlFor={`qty-${paymentItemId}`}>
            Corrected quantity for {reference}
          </label>
          <input
            id={`qty-${paymentItemId}`}
            className="input"
            inputMode="decimal"
            placeholder="Corrected quantity"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </div>
      )}

      <label className="sr-only" htmlFor={`why-${paymentItemId}`}>
        Reason for {reference}
      </label>
      <input
        id={`why-${paymentItemId}`}
        className="input"
        placeholder={
          mode === 'explain' ? 'Why is the difference correct?' : 'Why is a correction needed?'
        }
        value={text}
        onChange={(event) => setText(event.target.value)}
      />

      <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={submit}>
        {pending ? 'Saving…' : mode === 'explain' ? 'Clear the flag' : 'Supersede the item'}
      </button>

      {error && (
        <p role="alert" className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}
