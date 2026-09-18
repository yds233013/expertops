'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

/**
 * HUMAN DECISION on a screening.
 *
 * Qualifying needs at least one submitted review and no open conflict; the
 * server enforces both and the error explains which one blocked it. Resolving a
 * conflict is admin-only, so the control is only shown when the operator can
 * actually use it.
 */
export function ScreeningDecisionPanel({
  screeningId,
  reference,
  hasOpenConflict,
  canResolveConflict,
}: {
  screeningId: string;
  reference: string;
  hasOpenConflict: boolean;
  canResolveConflict: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(body: Record<string, unknown>, label: string) {
    setPending(label);
    setError(null);
    const result = await apiPost(`/api/screenings/${screeningId}`, body);
    setPending(null);
    if (!result.ok) {
      setError(result.error?.message ?? 'That decision could not be recorded.');
      return;
    }
    setNote('');
    router.refresh();
  }

  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3">
      <p className="text-xs font-semibold text-amber-900">Decision required on {reference}</p>

      <label className="label text-amber-900" htmlFor={`note-${screeningId}`}>
        Note explaining the decision
      </label>
      <textarea
        id={`note-${screeningId}`}
        className="textarea"
        rows={2}
        placeholder="Required to reject, to request a revision, or to resolve a conflict"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />

      {/* One box, two audiences — which is exactly the sort of thing an
          operator should not have to remember. A revision request is sent to
          the candidate verbatim; the other notes stay on the record. Checked
          against the candidate projection in `getScreeningForCandidate`, which
          returns `revisionFeedback` but never `decisionNote`. */}
      <dl className="rounded-md border border-amber-200 bg-white/70 px-2.5 py-2 text-[0.72rem] leading-snug">
        <div className="flex gap-1.5">
          <dt className="font-semibold text-amber-900">Request a revision:</dt>
          <dd className="text-ink-700">
            Requested changes — visible to the candidate, word for word, in their portal.
          </dd>
        </div>
        <div className="mt-1 flex gap-1.5">
          <dt className="font-semibold text-amber-900">
            Qualify, Do not qualify, Resolve conflict:
          </dt>
          <dd className="text-ink-700">
            Kept on the record for operators. The candidate never sees it.
          </dd>
        </div>
      </dl>

      {hasOpenConflict && (
        <p className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          Reviewers disagree.{' '}
          {canResolveConflict
            ? 'Resolve the conflict before qualifying or rejecting.'
            : 'An admin has to resolve this before a decision can be made.'}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={pending !== null || hasOpenConflict}
          onClick={() => send({ action: 'qualify', note: note.trim() || undefined }, 'qualify')}
        >
          {pending === 'qualify' ? 'Qualifying…' : 'Qualify'}
        </button>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={pending !== null || hasOpenConflict || note.trim().length === 0}
          onClick={() => send({ action: 'reject', note: note.trim() }, 'reject')}
        >
          {pending === 'reject' ? 'Saving…' : 'Do not qualify'}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={pending !== null || note.trim().length === 0}
          onClick={() => send({ action: 'request_revision', feedback: note.trim() }, 'revision')}
        >
          {pending === 'revision' ? 'Saving…' : 'Request a revision'}
        </button>

        {hasOpenConflict && canResolveConflict && (
          <>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={pending !== null || note.trim().length === 0}
              onClick={() =>
                send(
                  { action: 'resolve_conflict', resolution: 'APPROVE', note: note.trim() },
                  'conflict-approve',
                )
              }
            >
              Resolve as approve
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={pending !== null || note.trim().length === 0}
              onClick={() =>
                send(
                  { action: 'resolve_conflict', resolution: 'REJECT', note: note.trim() },
                  'conflict-reject',
                )
              }
            >
              Resolve as reject
            </button>
          </>
        )}
      </div>

      <p className="text-[0.7rem] text-amber-900">
        Qualifying makes the expert eligible. It does not staff them: onboarding verification, an
        accepted invitation and declared availability are still required.
      </p>

      {error && (
        <p role="alert" className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}
