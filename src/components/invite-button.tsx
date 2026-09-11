'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Opens a short form so the operator can add a note and a response deadline. */
export function InviteButton({
  projectId,
  expertId,
  expertName,
  matchCandidateId,
  disabled,
  disabledReason,
}: {
  projectId: string;
  expertId: string;
  expertName: string;
  matchCandidateId?: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [ttlHours, setTtlHours] = useState(72);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (disabled) {
    return (
      <span className="text-xs text-ink-400" title={disabledReason}>
        {disabledReason ?? 'Not invitable'}
      </span>
    );
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        Invite
      </button>
    );
  }

  async function send() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/invitations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expertId,
          message: message.trim() || undefined,
          ttlHours,
          matchCandidateId: matchCandidateId ?? null,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error?.message ?? 'The invitation could not be created.');
        return;
      }
      setOpen(false);
      setMessage('');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="w-72 space-y-2 rounded-lg border border-ink-200 bg-white p-2 shadow-sm">
      <p className="text-xs font-semibold text-ink-800">Invite {expertName}</p>
      <textarea
        className="textarea"
        rows={2}
        placeholder="Optional note for the expert"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
      />
      <label className="label" htmlFor={`ttl-${expertId}`}>
        Respond within
      </label>
      <select
        id={`ttl-${expertId}`}
        className="select"
        value={ttlHours}
        onChange={(event) => setTtlHours(Number(event.target.value))}
      >
        <option value={24}>24 hours</option>
        <option value={48}>48 hours</option>
        <option value={72}>72 hours</option>
        <option value={168}>7 days</option>
      </select>
      {error && (
        <p role="alert" className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={send}>
          {pending ? 'Queueing…' : 'Send invitation'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <p className="text-[0.7rem] text-ink-500">
        The worker renders the email into the simulated outbox. Nothing is sent to a mail server.
      </p>
    </div>
  );
}
