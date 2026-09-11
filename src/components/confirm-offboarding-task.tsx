'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

/**
 * HUMAN CONFIRMATION of something done outside this system.
 *
 * The note is mandatory because ExpertOps has no way to check. The operator's
 * statement is the only evidence there is, so it has to be on the record.
 */
export function ConfirmOffboardingTask({ taskId, label }: { taskId: string; label: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(notApplicable: boolean) {
    if (!note.trim()) {
      setError('A note is required: this system cannot verify the task itself.');
      return;
    }
    setPending(true);
    setError(null);

    const result = await apiPost(`/api/offboarding-tasks/${taskId}`, {
      note: note.trim(),
      notApplicable,
    });
    setPending(false);

    if (!result.ok) {
      setError(result.error?.message ?? 'That could not be recorded.');
      return;
    }
    setNote('');
    router.refresh();
  }

  return (
    <div className="w-72 space-y-1.5">
      <label className="sr-only" htmlFor={`offboard-note-${taskId}`}>
        Confirmation note for {label}
      </label>
      <input
        id={`offboard-note-${taskId}`}
        className="input"
        placeholder="What did you do, and how do you know?"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={pending}
          onClick={() => confirm(false)}
        >
          {pending ? 'Saving…' : 'I confirm'}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={pending}
          onClick={() => confirm(true)}
        >
          Not applicable
        </button>
      </div>
      {error && (
        <p role="alert" className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}
