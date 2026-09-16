'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Badge } from '@/components/ui';

export interface ReviewCriterion {
  key: string;
  label: string;
  scoringGuidance: string;
  maxScore: number;
  weight: number;
  isGating: boolean;
}

/**
 * HUMAN DECISION. The assigned reviewer records their assessment.
 *
 * Private notes are labelled with who can read them rather than with a field
 * name, because that distinction is the whole point of having two boxes.
 * Requesting a revision requires feedback the candidate can act on; the service
 * refuses without it and the refusal is shown here.
 */
export function ReviewForm({
  reviewId,
  reference,
  criteria,
  passThreshold,
}: {
  reviewId: string;
  reference: string;
  criteria: ReviewCriterion[];
  passThreshold: number;
}) {
  const router = useRouter();
  const [scores, setScores] = useState<Record<string, number>>(() =>
    Object.fromEntries(criteria.map((criterion) => [criterion.key, 0])),
  );
  const [publicFeedback, setPublicFeedback] = useState('');
  const [privateNotes, setPrivateNotes] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const weighted = criteria.reduce(
    (total, criterion) => total + (scores[criterion.key] ?? 0) * criterion.weight,
    0,
  );
  const maxWeighted = criteria.reduce(
    (total, criterion) => total + criterion.maxScore * criterion.weight,
    0,
  );

  async function submit(decision: 'APPROVE' | 'REJECT' | 'REQUEST_REVISION') {
    setPending(decision);
    setError(null);
    try {
      const result = await apiPost(`/api/reviews/${reviewId}`, {
        decision,
        scores,
        publicFeedback: publicFeedback.trim() || undefined,
        privateNotes: privateNotes.trim() || undefined,
      });
      if (!result.ok) {
        setError(result.error?.message ?? 'The review could not be recorded.');
        return;
      }
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-accent-100 bg-accent-50 px-3 py-3">
      <h3 className="text-sm font-semibold text-ink-900">Your review of {reference}</h3>

      <div className="space-y-3">
        {criteria.map((criterion) => (
          <div key={criterion.key}>
            <label
              htmlFor={`score-${reviewId}-${criterion.key}`}
              className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-900"
            >
              {criterion.label}
              <Badge tone="muted">weight {criterion.weight}</Badge>
              {criterion.isGating && <Badge tone="danger">gating</Badge>}
            </label>
            {criterion.scoringGuidance && (
              <p id={`help-${reviewId}-${criterion.key}`} className="mt-0.5 text-xs text-ink-600">
                {criterion.scoringGuidance}
              </p>
            )}
            <input
              id={`score-${reviewId}-${criterion.key}`}
              type="number"
              min={0}
              max={criterion.maxScore}
              className="input mt-1 w-24"
              aria-describedby={
                criterion.scoringGuidance ? `help-${reviewId}-${criterion.key}` : undefined
              }
              value={scores[criterion.key] ?? 0}
              onChange={(event) =>
                setScores((previous) => ({
                  ...previous,
                  [criterion.key]: Number(event.target.value),
                }))
              }
            />
            <span className="ml-2 text-xs text-ink-500">of {criterion.maxScore}</span>
          </div>
        ))}
      </div>

      <p className="text-xs text-ink-700" role="status">
        Weighted total {weighted} of {maxWeighted}. Pass threshold is {passThreshold}, and it is
        advisory: the decision is yours.
      </p>

      <div>
        <label htmlFor={`public-${reviewId}`} className="label">
          Feedback the candidate will read
        </label>
        <textarea
          id={`public-${reviewId}`}
          rows={3}
          className="input"
          value={publicFeedback}
          onChange={(event) => setPublicFeedback(event.target.value)}
        />
      </div>

      <div>
        <label htmlFor={`private-${reviewId}`} className="label">
          Private notes, never shown to the candidate
        </label>
        <textarea
          id={`private-${reviewId}`}
          rows={3}
          className="input"
          value={privateNotes}
          onChange={(event) => setPrivateNotes(event.target.value)}
        />
      </div>

      {error && (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={pending !== null}
          onClick={() => submit('APPROVE')}
        >
          {pending === 'APPROVE' ? 'Recording…' : 'Recommend approve'}
        </button>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={pending !== null}
          onClick={() => submit('REJECT')}
        >
          {pending === 'REJECT' ? 'Recording…' : 'Recommend reject'}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={pending !== null}
          onClick={() => submit('REQUEST_REVISION')}
        >
          {pending === 'REQUEST_REVISION' ? 'Recording…' : 'Ask for a revision'}
        </button>
      </div>
    </div>
  );
}

/** Assign a human reviewer to a screening. Idempotent per reviewer. */
export function AssignReviewerPanel({
  screeningId,
  reviewers,
}: {
  screeningId: string;
  reviewers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [reviewerId, setReviewerId] = useState(reviewers[0]?.id ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (reviewers.length === 0) return null;

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor={`reviewer-${screeningId}`} className="label">
          Assign a reviewer
        </label>
        <select
          id={`reviewer-${screeningId}`}
          className="input mt-1"
          value={reviewerId}
          onChange={(event) => setReviewerId(event.target.value)}
        >
          {reviewers.map((reviewer) => (
            <option key={reviewer.id} value={reviewer.id}>
              {reviewer.name}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={pending || !reviewerId}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            const result = await apiPost(`/api/screenings/${screeningId}`, {
              action: 'assign_reviewer',
              reviewerId,
            });
            if (!result.ok) {
              setError(result.error?.message ?? 'The reviewer could not be assigned.');
              // The usual cause is that the worker assigned someone while this
              // page was open, so the screen is out of date. Re-render it: the
              // message stays, and what it describes becomes visible.
              router.refresh();
              return;
            }
            router.refresh();
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Assigning…' : 'Assign'}
      </button>
      {error && (
        <p role="alert" className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}
