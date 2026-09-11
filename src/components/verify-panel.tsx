'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The human confirmation step. Verification is never automatic: an operator has
 * to approve or return each submission, and returning one requires a reason.
 */
export function VerifyPanel({ expertId, expertName }: { expertId: string; expertName: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setPending(approve ? 'approve' : 'reject');
    setError(null);
    try {
      const response = await fetch(`/api/experts/${expertId}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approve, note: note.trim() || undefined }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? 'The decision could not be recorded.');
        return;
      }
      setNote('');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3">
      <p className="text-xs font-semibold text-amber-900">
        Operator decision required for {expertName}
      </p>
      <textarea
        className="textarea"
        rows={2}
        placeholder="Note (required when returning a submission)"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={pending !== null}
          onClick={() => decide(true)}
        >
          {pending === 'approve' ? 'Verifying…' : 'Verify expert'}
        </button>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={pending !== null}
          onClick={() => decide(false)}
        >
          {pending === 'reject' ? 'Returning…' : 'Return for changes'}
        </button>
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}
