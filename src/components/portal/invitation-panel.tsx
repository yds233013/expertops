'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

export function InvitationPanel({ invitationId }: { invitationId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<'idle' | 'declining'>('idle');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function respond(accept: boolean) {
    setPending(true);
    setError(null);
    try {
      const result = await apiPost(`/api/portal/invitations/${invitationId}/respond`, {
        accept,
        declineReason: accept ? undefined : reason.trim(),
      });
      if (!result.ok) {
        setError(result.error?.message ?? 'Your response could not be recorded.');
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      {mode === 'idle' ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={pending}
            onClick={() => respond(true)}
          >
            {pending ? 'Saving…' : 'Accept'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={pending}
            onClick={() => setMode('declining')}
          >
            Decline
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <label className="label" htmlFor={`reason-${invitationId}`}>
            Reason for declining
          </label>
          <input
            id={`reason-${invitationId}`}
            className="input"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Not available in that window"
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={pending || reason.trim().length === 0}
              onClick={() => respond(false)}
            >
              {pending ? 'Saving…' : 'Send decline'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setMode('idle')}
            >
              Back
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="alert alert-error text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
