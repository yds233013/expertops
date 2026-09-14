'use client';

import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
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
 */
export function ApplyForm({ slug, questions }: { slug: string; questions: Question[] }) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [experience, setExperience] = useState('');
  const [skills, setSkills] = useState('');
  const [weeklyHours, setWeeklyHours] = useState('');
  const [links, setLinks] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
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
        setPending(true);
        setError(null);
        try {
          const result = await apiPost('/api/opportunities/apply', {
            opportunitySlug: slug,
            fullName,
            email,
            experience,
            skills: skills
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean),
            weeklyHours: weeklyHours ? Number(weeklyHours) : null,
            answers,
            workSampleLinks: links
              .split('\n')
              .map((value) => value.trim())
              .filter(Boolean),
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
          <input
            id="apply-name"
            className="input"
            required
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="apply-email">
            Email
          </label>
          <input
            id="apply-email"
            className="input"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <p className="field-hint">We use this to send you a screening link.</p>
        </div>
      </div>

      <div>
        <label className="label" htmlFor="apply-experience">
          Relevant experience
        </label>
        <textarea
          id="apply-experience"
          className="textarea"
          rows={5}
          required
          value={experience}
          onChange={(event) => setExperience(event.target.value)}
        />
        <p className="field-hint">Work you have actually done that bears on this.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="apply-skills">
            Skills
          </label>
          <input
            id="apply-skills"
            className="input"
            value={skills}
            onChange={(event) => setSkills(event.target.value)}
          />
          <p className="field-hint">Comma separated.</p>
        </div>
        <div>
          <label className="label" htmlFor="apply-hours">
            Hours per week you are available
          </label>
          <input
            id="apply-hours"
            className="input"
            type="number"
            min={1}
            max={80}
            value={weeklyHours}
            onChange={(event) => setWeeklyHours(event.target.value)}
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
            className="textarea"
            rows={3}
            required={question.required}
            value={answers[question.key] ?? ''}
            onChange={(event) =>
              setAnswers((current) => ({ ...current, [question.key]: event.target.value }))
            }
          />
          {question.helpText && <p className="field-hint">{question.helpText}</p>}
        </div>
      ))}

      <div>
        <label className="label" htmlFor="apply-links">
          Work sample links (optional)
        </label>
        <textarea
          id="apply-links"
          className="textarea"
          rows={2}
          value={links}
          onChange={(event) => setLinks(event.target.value)}
        />
        <p className="field-hint">
          One URL per line. Links are recorded as text and are never opened by ExpertOps.
        </p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <button className="btn btn-primary" type="submit" disabled={pending}>
        {pending ? 'Submitting…' : 'Submit application'}
      </button>
    </form>
  );
}
