'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Badge } from '@/components/ui';

export interface CriterionView {
  key: string;
  label: string;
  scoringGuidance: string;
  requiredEvidence: string;
  maxScore: number;
}

const EVIDENCE_HINT: Record<string, string> = {
  WORK_SAMPLE_LINK: 'Needs a work sample link',
  WRITTEN_ANSWER: 'Needs a written answer',
  REFERENCE_STATEMENT: 'Needs a reference statement',
};

/**
 * The candidate's answer form.
 *
 * It never decides whether a submission is acceptable. Missing evidence is
 * reported by the server after the submission is recorded, because an
 * incomplete attempt is still worth capturing.
 */
export function ScreeningForm({
  screeningId,
  criteria,
  initialAnswers,
  initialLinks,
  initialNote,
  submitLabel,
}: {
  screeningId: string;
  criteria: CriterionView[];
  initialAnswers: Record<string, string>;
  initialLinks: string[];
  initialNote: string;
  submitLabel: string;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(criteria.map((c) => [c.key, initialAnswers[c.key] ?? ''])),
  );
  const [links, setLinks] = useState(initialLinks.join('\n'));
  const [note, setNote] = useState(initialNote);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMissing(null);
    try {
      const result = await apiPost<{ missingEvidence: string[] }>(
        `/api/apply/screenings/${screeningId}`,
        {
          answers,
          workSampleLinks: links
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          note,
        },
      );
      if (!result.ok) {
        setError(result.error?.message ?? 'Your responses could not be submitted.');
        return;
      }
      setMissing(result.data?.missingEvidence ?? []);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      {criteria.map((criterion) => {
        const hint = EVIDENCE_HINT[criterion.requiredEvidence];
        return (
          <div key={criterion.key}>
            <label
              htmlFor={`answer-${criterion.key}`}
              className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink-900"
            >
              {criterion.label}
              {hint && <Badge tone="warning">{hint}</Badge>}
            </label>
            {criterion.scoringGuidance && (
              <p id={`guidance-${criterion.key}`} className="mt-1 text-xs text-ink-600">
                {criterion.scoringGuidance}
              </p>
            )}
            <textarea
              id={`answer-${criterion.key}`}
              name={`answer-${criterion.key}`}
              aria-describedby={criterion.scoringGuidance ? `guidance-${criterion.key}` : undefined}
              rows={5}
              className="input mt-2 w-full"
              value={answers[criterion.key] ?? ''}
              onChange={(event) =>
                setAnswers((previous) => ({ ...previous, [criterion.key]: event.target.value }))
              }
            />
          </div>
        );
      })}

      <div>
        <label htmlFor="work-sample-links" className="text-sm font-semibold text-ink-900">
          Work sample links
        </label>
        <p id="links-help" className="mt-1 text-xs text-ink-600">
          One URL per line. Links are recorded as text and are never opened by ExpertOps.
        </p>
        <textarea
          id="work-sample-links"
          name="workSampleLinks"
          aria-describedby="links-help"
          rows={3}
          className="input mt-2 w-full font-mono text-xs"
          value={links}
          onChange={(event) => setLinks(event.target.value)}
        />
      </div>

      <div>
        <label htmlFor="submission-note" className="text-sm font-semibold text-ink-900">
          Anything else you want the reviewer to know
        </label>
        <textarea
          id="submission-note"
          name="note"
          rows={3}
          className="input mt-2 w-full"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      )}

      {missing !== null &&
        (missing.length === 0 ? (
          <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            Submitted. Nothing further is needed from you right now.
          </p>
        ) : (
          <div role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p>Submitted, but some required evidence is missing:</p>
            <ul className="mt-1 list-disc pl-5">
              {missing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="mt-1">You can add it and submit again while the window is open.</p>
          </div>
        ))}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? 'Submitting…' : submitLabel}
      </button>
    </form>
  );
}
