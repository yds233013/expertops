'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function WithdrawButton({ invitationId }: { invitationId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        Withdraw
      </button>
    );
  }

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/invitations/${invitationId}/withdraw`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error?.message ?? 'The invitation could not be withdrawn.');
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="w-56 space-y-1.5">
      <input
        className="input"
        placeholder="Reason (required)"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {error && <p className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={pending || reason.trim().length === 0}
          onClick={submit}
        >
          {pending ? 'Withdrawing…' : 'Confirm'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
