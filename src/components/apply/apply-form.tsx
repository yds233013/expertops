'use client';

import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { formValues, splitLines, splitList } from '@/lib/form-values';
import { useHydrated } from '@/lib/use-hydrated';
import { Alert } from '@/components/ui';

interface Question {
  key: string;
  label: string;
  helpText?: string;
  required: boolean;
}

/**
 * The application form.
 *
 * On success it swaps itself for the confirmation rather than navigating, so
 * the reference stays on screen and a refresh cannot resubmit. A second
 * submission of the same address to the same opportunity is not an error — the
 * server finds the application that already exists and says so.
 *
 * The fields are uncontrolled. This is the coldest load in the product — a
 * stranger arriving from a link, often on a slow connection — so the window
 * between the HTML arriving and React attaching is real, and anything typed
 * into it would be dropped by an input that reads its value from state. The
 * form is read from the DOM at submit time instead.
 */
export function ApplyForm({ slug, questions }: { slug: string; questions: Question[] }) {
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ reference: string; already: boolean } | null>(null);

  if (done) {
    return (
      <div className="space-y-3">
        <Alert tone="success">
          {done.already
            ? `You have already applied to this one. Your reference is ${done.reference}.`
            : `Application received. Your reference is ${done.reference}.`}
        </Alert>
        <div>
          <h3 className="section-title">What happens next</h3>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-ink-700">
            <li>An operator reads your application. Nothing is decided automatically.</li>
            <li>
              If it looks like a fit, they send you a screening exercise by email, with a private
              link to complete it.
            </li>
            <li>
              A human reviews what you submit and decides. You can ask us to withdraw at any point.
            </li>
          </ol>
          <p className="mt-2 text-xs text-ink-500">
            Keep your reference. Quote it if you get in touch about this application.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        const values = formValues(event.currentTarget);
        setPending(true);
        setError(null);
        try {
          const result = await apiPost('/api/opportunities/apply', {
            opportunitySlug: slug,
            fullName: values.fullName ?? '',
            email: values.email ?? '',
            experience: values.experience ?? '',
            skills: splitList(values.skills),
            weeklyHours: values.weeklyHours ? Number(values.weeklyHours) : null,
            answers: Object.fromEntries(
              questions.map((question) => [question.key, values[`q-${question.key}`] ?? '']),
            ),
            workSampleLinks: splitLines(values.workSampleLinks),
          });
          if (!result.ok) {
            setError(result.error?.message ?? 'The application could not be submitted.');
            return;
          }
          const data = result.data as { reference: string; alreadyApplied: boolean };
          setDone({ reference: data.reference, already: data.alreadyApplied });
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="apply-name">
            Your name
          </label>
          <input id="apply-name" name="fullName" className="input" required />
        </div>
        <div>
          <label className="label" htmlFor="apply-email">
            Email
          </label>
          <input id="apply-email" name="email" className="input" type="email" required />
          <p className="field-hint">We use this to send you a screening link.</p>
        </div>
      </div>

      <div>
        <label className="label" htmlFor="apply-experience">
          Relevant experience
        </label>
        <textarea id="apply-experience" name="experience" className="textarea" rows={5} required />
        <p className="field-hint">Work you have actually done that bears on this.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="apply-skills">
            Skills
          </label>
          <input id="apply-skills" name="skills" className="input" />
          <p className="field-hint">Comma separated.</p>
        </div>
        <div>
          <label className="label" htmlFor="apply-hours">
            Hours per week you are available
          </label>
          <input
            id="apply-hours"
            name="weeklyHours"
            className="input"
            type="number"
            min={1}
            max={80}
          />
        </div>
      </div>

      {questions.map((question) => (
        <div key={question.key}>
          <label className="label" htmlFor={`q-${question.key}`}>
            {question.label}
            {question.required ? '' : ' (optional)'}
          </label>
          <textarea
            id={`q-${question.key}`}
            name={`q-${question.key}`}
            className="textarea"
            rows={3}
            required={question.required}
          />
          {question.helpText && <p className="field-hint">{question.helpText}</p>}
        </div>
      ))}

      <div>
        <label className="label" htmlFor="apply-links">
          Work sample links (optional)
        </label>
        <textarea id="apply-links" name="workSampleLinks" className="textarea" rows={2} />
        <p className="field-hint">
          One URL per line. Links are recorded as text and are never opened by ExpertOps.
        </p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <button
        className="btn btn-primary"
        type="submit"
        disabled={pending || !hydrated}
        aria-busy={!hydrated}
      >
        {pending ? 'Submitting…' : 'Submit application'}
      </button>
    </form>
  );
}
