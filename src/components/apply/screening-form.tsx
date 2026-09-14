'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { formValues, splitLines } from '@/lib/form-values';
import { useHydrated } from '@/lib/use-hydrated';
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
 *
 * The fields are uncontrolled on purpose. This page is loaded cold from a link
 * in a message, so there is a real window in which the form is on screen and
 * React is not yet attached; a candidate typing in that window would have their
 * answer dropped at submit time by a controlled input reading empty state. The
 * DOM is read instead, which is where their answer actually is.
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
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = formValues(event.currentTarget);
    setPending(true);
    setError(null);
    setMissing(null);
    try {
      const result = await apiPost<{ missingEvidence: string[] }>(
        `/api/apply/screenings/${screeningId}`,
        {
          answers: Object.fromEntries(
            criteria.map((criterion) => [criterion.key, values[`answer-${criterion.key}`] ?? '']),
          ),
          workSampleLinks: splitLines(values.workSampleLinks),
          note: values.note ?? '',
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
              defaultValue={initialAnswers[criterion.key] ?? ''}
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
          defaultValue={initialLinks.join('\n')}
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
          defaultValue={initialNote}
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

      <button
        type="submit"
        className="btn btn-primary"
        disabled={pending || !hydrated}
        aria-busy={!hydrated}
      >
        {pending ? 'Submitting…' : submitLabel}
      </button>
    </form>
  );
}
