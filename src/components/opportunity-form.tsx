'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Alert } from '@/components/ui';

interface Option {
  id: string;
  name?: string;
  code?: string;
  title?: string;
}

interface QuestionDraft {
  label: string;
  helpText: string;
  required: boolean;
}

/**
 * Create or edit an opportunity.
 *
 * The internal-notes field is on the same form as the description on purpose:
 * an operator writing client-sensitive context should be able to see, in the
 * same glance, which box is published and which is not. The label says so, and
 * the candidate-facing projection cannot return it either way.
 */
export function OpportunityForm({
  domains,
  projects,
  campaigns,
  existing,
}: {
  domains: Option[];
  projects: Option[];
  campaigns: Option[];
  existing?: {
    id: string;
    title: string;
    kind: string;
    projectId: string | null;
    summary: string;
    description: string;
    responsibilities: string;
    requiredSkills: string[];
    questions: QuestionDraft[];
    weeklyHoursMin: number | null;
    weeklyHoursMax: number | null;
    applicationDeadline: string | null;
    compensationNote: string;
    internalNotes: string;
  };
}) {
  const router = useRouter();
  const [title, setTitle] = useState(existing?.title ?? '');
  const [kind, setKind] = useState(existing?.kind ?? 'PROJECT_ENGAGEMENT');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? '');
  const [projectId, setProjectId] = useState(existing?.projectId ?? '');
  const [campaignId, setCampaignId] = useState('');
  const [summary, setSummary] = useState(existing?.summary ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [responsibilities, setResponsibilities] = useState(existing?.responsibilities ?? '');
  const [skills, setSkills] = useState((existing?.requiredSkills ?? []).join(', '));
  const [hoursMin, setHoursMin] = useState(existing?.weeklyHoursMin?.toString() ?? '');
  const [hoursMax, setHoursMax] = useState(existing?.weeklyHoursMax?.toString() ?? '');
  const [deadline, setDeadline] = useState(existing?.applicationDeadline?.slice(0, 10) ?? '');
  const [compensationNote, setCompensationNote] = useState(existing?.compensationNote ?? '');
  const [internalNotes, setInternalNotes] = useState(existing?.internalNotes ?? '');
  const [questions, setQuestions] = useState<QuestionDraft[]>(
    existing?.questions?.length ? existing.questions : [],
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const payload = () => ({
    title,
    kind,
    domainId,
    projectId: projectId || null,
    campaignId: campaignId || null,
    summary,
    description,
    responsibilities,
    requiredSkills: skills
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    questions: questions
      .filter((question) => question.label.trim())
      .map((question) => ({
        key: question.label,
        label: question.label,
        helpText: question.helpText || undefined,
        required: question.required,
      })),
    weeklyHoursMin: hoursMin ? Number(hoursMin) : null,
    weeklyHoursMax: hoursMax ? Number(hoursMax) : null,
    applicationDeadline: deadline ? new Date(`${deadline}T23:59:59.999Z`).toISOString() : null,
    compensationNote,
    internalNotes,
  });

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        setNotice(null);
        try {
          const result = existing
            ? await apiPost(`/api/opportunities/${existing.id}`, {
                action: 'update',
                ...payload(),
              })
            : await apiPost('/api/opportunities', payload());
          if (!result.ok) {
            setError(result.error?.message ?? 'The opportunity could not be saved.');
            return;
          }
          if (existing) {
            setNotice('Saved.');
            router.refresh();
          } else {
            const data = result.data as { opportunity: { id: string } };
            router.push(`/opportunities/${data.opportunity.id}`);
          }
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="opp-title">
            Title
          </label>
          <input
            id="opp-title"
            className="input"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="opp-kind">
            Kind
          </label>
          <select
            id="opp-kind"
            className="select"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="PROJECT_ENGAGEMENT">Project engagement</option>
            <option value="NETWORK_MEMBERSHIP">Expert network (ongoing)</option>
          </select>
          <p className="field-hint">Applicants see this label on the listing.</p>
        </div>
      </div>

      {!existing && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="opp-domain">
              Domain
            </label>
            <select
              id="opp-domain"
              className="select"
              value={domainId}
              onChange={(event) => setDomainId(event.target.value)}
            >
              {domains.map((domain) => (
                <option key={domain.id} value={domain.id}>
                  {domain.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="opp-campaign">
              Campaign (optional)
            </label>
            <select
              id="opp-campaign"
              className="select"
              value={campaignId}
              onChange={(event) => setCampaignId(event.target.value)}
            >
              <option value="">Not linked</option>
              {campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="opp-project">
              Project (optional)
            </label>
            <select
              id="opp-project"
              className="select"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">Not linked</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.code} · {project.title}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div>
        <label className="label" htmlFor="opp-summary">
          Summary
        </label>
        <input
          id="opp-summary"
          className="input"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
        />
        <p className="field-hint">One line, shown on the listing.</p>
      </div>

      <div>
        <label className="label" htmlFor="opp-description">
          Description
        </label>
        <textarea
          id="opp-description"
          className="textarea"
          rows={4}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="opp-responsibilities">
          Responsibilities
        </label>
        <textarea
          id="opp-responsibilities"
          className="textarea"
          rows={3}
          value={responsibilities}
          onChange={(event) => setResponsibilities(event.target.value)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label" htmlFor="opp-skills">
            Required skills
          </label>
          <input
            id="opp-skills"
            className="input"
            value={skills}
            onChange={(event) => setSkills(event.target.value)}
          />
          <p className="field-hint">Comma separated.</p>
        </div>
        <div>
          <label className="label" htmlFor="opp-hours-min">
            Hours/week from
          </label>
          <input
            id="opp-hours-min"
            className="input"
            type="number"
            min={1}
            max={80}
            value={hoursMin}
            onChange={(event) => setHoursMin(event.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="opp-hours-max">
            Hours/week to
          </label>
          <input
            id="opp-hours-max"
            className="input"
            type="number"
            min={1}
            max={80}
            value={hoursMax}
            onChange={(event) => setHoursMax(event.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="opp-deadline">
            Application deadline
          </label>
          <input
            id="opp-deadline"
            className="input"
            type="date"
            value={deadline}
            onChange={(event) => setDeadline(event.target.value)}
          />
          <p className="field-hint">After this, applications are refused.</p>
        </div>
      </div>

      <div>
        <label className="label" htmlFor="opp-compensation">
          Compensation
        </label>
        <input
          id="opp-compensation"
          className="input"
          value={compensationNote}
          onChange={(event) => setCompensationNote(event.target.value)}
        />
        <p className="field-hint">Only fill this when a figure has actually been agreed.</p>
      </div>

      <fieldset className="rounded-lg border border-ink-200 px-3 py-3">
        <legend className="label mb-0 px-1">Questions for applicants</legend>
        {questions.length === 0 && (
          <p className="text-xs text-ink-500">
            None yet. Applicants always give their name, email, experience, skills and availability.
          </p>
        )}
        <div className="space-y-2">
          {questions.map((question, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
              <input
                className="input"
                aria-label={`Question ${index + 1} label`}
                placeholder="What do you want to ask?"
                value={question.label}
                onChange={(event) =>
                  setQuestions((rows) =>
                    rows.map((row, i) =>
                      i === index ? { ...row, label: event.target.value } : row,
                    ),
                  )
                }
              />
              <input
                className="input"
                aria-label={`Question ${index + 1} help text`}
                placeholder="Help text (optional)"
                value={question.helpText}
                onChange={(event) =>
                  setQuestions((rows) =>
                    rows.map((row, i) =>
                      i === index ? { ...row, helpText: event.target.value } : row,
                    ),
                  )
                }
              />
              <label className="flex items-center gap-1.5 text-xs text-ink-600">
                <input
                  type="checkbox"
                  checked={question.required}
                  onChange={(event) =>
                    setQuestions((rows) =>
                      rows.map((row, i) =>
                        i === index ? { ...row, required: event.target.checked } : row,
                      ),
                    )
                  }
                />
                Required
              </label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setQuestions((rows) => rows.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm mt-2"
          onClick={() =>
            setQuestions((rows) => [...rows, { label: '', helpText: '', required: false }])
          }
        >
          Add question
        </button>
      </fieldset>

      <div>
        <label className="label" htmlFor="opp-internal">
          Internal notes — never shown to applicants
        </label>
        <textarea
          id="opp-internal"
          className="textarea"
          rows={3}
          value={internalNotes}
          onChange={(event) => setInternalNotes(event.target.value)}
        />
        <p className="field-hint">
          Client identity, rate ceilings, anything you would not put on a public page.
        </p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <button className="btn btn-primary" type="submit" disabled={pending}>
        {pending ? 'Saving…' : existing ? 'Save changes' : 'Create draft'}
      </button>
    </form>
  );
}
