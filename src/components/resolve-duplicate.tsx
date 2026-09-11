'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

/**
 * The human decision on a suspected duplicate person.
 *
 * Both outcomes need a note. Confirming a match withdraws the newer record and
 * keeps both on file; it does not merge or delete anything.
 */
export function ResolveDuplicate({ flagId, name }: { flagId: string; name: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<'same' | 'different' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(samePerson: boolean) {
    if (!note.trim()) {
      setError('A note is required so the decision can be understood later.');
      return;
    }
    setPending(samePerson ? 'same' : 'different');
    setError(null);

    const result = await apiPost(`/api/duplicates/${flagId}`, {
      samePerson,
      note: note.trim(),
    });
    setPending(null);

    if (!result.ok) {
      setError(result.error?.message ?? 'The decision could not be recorded.');
      return;
    }
    setNote('');
    router.refresh();
  }

  return (
    <div className="w-72 space-y-2">
      <label className="sr-only" htmlFor={`dup-note-${flagId}`}>
        Note explaining the decision about {name}
      </label>
      <input
        id={`dup-note-${flagId}`}
        className="input"
        placeholder="Why do you think so?"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={pending !== null}
          onClick={() => decide(true)}
        >
          {pending === 'same' ? 'Saving…' : 'Same person'}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={pending !== null}
          onClick={() => decide(false)}
        >
          {pending === 'different' ? 'Saving…' : 'Different people'}
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
