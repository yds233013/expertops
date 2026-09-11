'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

/**
 * Take, reassign or dismiss an attention item.
 *
 * Dismissing needs a reason: an item that is being set aside without one is
 * indistinguishable later from one that was genuinely handled.
 */
export function AttentionActions({
  itemId,
  currentOwnerId,
  operators,
  selfId,
}: {
  itemId: string;
  currentOwnerId: string | null;
  operators: Array<{ id: string; name: string }>;
  selfId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');

  async function send(body: unknown) {
    setPending(true);
    setError(null);
    const result = await apiPost(`/api/attention/${itemId}`, body);
    setPending(false);
    if (!result.ok) {
      setError(result.error?.message ?? 'That action could not be completed.');
      return;
    }
    setDismissing(false);
    setReason('');
    router.refresh();
  }

  return (
    <div className="flex w-56 shrink-0 flex-col gap-2">
      <label className="sr-only" htmlFor={`owner-${itemId}`}>
        Assign owner
      </label>
      <select
        id={`owner-${itemId}`}
        className="select"
        disabled={pending}
        value={currentOwnerId ?? ''}
        onChange={(event) => send({ action: 'assign', ownerId: event.target.value || null })}
      >
        <option value="">Unassigned</option>
        {operators.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
            {person.id === selfId ? ' (you)' : ''}
          </option>
        ))}
      </select>

      {currentOwnerId !== selfId && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={pending}
          onClick={() => send({ action: 'assign', ownerId: selfId })}
        >
          Take this
        </button>
      )}

      {dismissing ? (
        <div className="space-y-1.5">
          <label className="sr-only" htmlFor={`reason-${itemId}`}>
            Reason for dismissing
          </label>
          <input
            id={`reason-${itemId}`}
            className="input"
            placeholder="Why is this not a problem?"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={pending || reason.trim().length === 0}
              onClick={() => send({ action: 'dismiss', reason: reason.trim() })}
            >
              Dismiss
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setDismissing(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={pending}
          onClick={() => setDismissing(true)}
        >
          Dismiss
        </button>
      )}

      {error && (
        <p role="alert" className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}
