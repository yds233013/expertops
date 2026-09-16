'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

interface RequirementRow {
  skillName: string;
  required: boolean;
  minProficiency: number;
  weight: number;
}

export function ProjectForm({
  skillNames,
  timezones,
}: {
  skillNames: string[];
  timezones: string[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<RequirementRow[]>([
    { skillName: '', required: true, minProficiency: 3, weight: 4 },
  ]);

  function patch(index: number, changes: Partial<RequirementRow>) {
    setRequirements((rows) => rows.map((row, i) => (i === index ? { ...row, ...changes } : row)));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const rateCeiling = String(form.get('maxHourlyRate') ?? '').trim();

    const payload = {
      title: String(form.get('title') ?? '').trim(),
      clientName: String(form.get('clientName') ?? '').trim(),
      description: String(form.get('description') ?? '').trim() || undefined,
      seatsRequested: Number(form.get('seatsRequested') ?? 1),
      minYearsExperience: Number(form.get('minYearsExperience') ?? 0),
      maxHourlyRateCents: rateCeiling ? Math.round(Number(rateCeiling) * 100) : null,
      preferredTimezone: String(form.get('preferredTimezone') ?? 'UTC'),
      startDate: String(form.get('startDate') ?? '') || null,
      endDate: String(form.get('endDate') ?? '') || null,
      requirements: requirements
        .filter((row) => row.skillName.trim().length > 0)
        .map((row) => ({
          skillName: row.skillName.trim(),
          required: row.required,
          minProficiency: row.minProficiency,
          weight: row.weight,
        })),
    };

    try {
      const result = await apiPost<{ project: { id: string } }>('/api/projects', payload);
      if (!result.ok || !result.data) {
        setError(result.error?.message ?? 'The project could not be created.');
        return;
      }
      router.push(`/projects/${result.data.project.id}`);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card space-y-4 px-4 py-4" onSubmit={onSubmit}>
      <datalist id="project-skill-options">
        {skillNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="title">
            Title
          </label>
          <input id="title" name="title" className="input" required maxLength={200} />
        </div>
        <div>
          <label className="label" htmlFor="clientName">
            Client
          </label>
          <input id="clientName" name="clientName" className="input" required maxLength={160} />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="description">
          Scope
        </label>
        <textarea
          id="description"
          name="description"
          className="textarea"
          rows={3}
          maxLength={8000}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className="label" htmlFor="seatsRequested">
            Seats
          </label>
          <input
            id="seatsRequested"
            name="seatsRequested"
            type="number"
            min={1}
            max={50}
            defaultValue={1}
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor="minYearsExperience">
            Min. experience
          </label>
          <input
            id="minYearsExperience"
            name="minYearsExperience"
            type="number"
            min={0}
            max={60}
            defaultValue={5}
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor="maxHourlyRate">
            Rate ceiling (USD/h)
          </label>
          <input
            id="maxHourlyRate"
            name="maxHourlyRate"
            type="number"
            min={0}
            step={5}
            className="input"
            placeholder="optional"
          />
        </div>
        <div>
          <label className="label" htmlFor="preferredTimezone">
            Preferred timezone
          </label>
          <select
            id="preferredTimezone"
            name="preferredTimezone"
            className="select"
            defaultValue="UTC"
          >
            {timezones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="startDate">
            Start date
          </label>
          <input id="startDate" name="startDate" type="date" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="endDate">
            End date
          </label>
          <input id="endDate" name="endDate" type="date" className="input" />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="label">Skill requirements</legend>
        <p className="text-xs text-ink-500">
          A required skill is a hard filter: experts without it are excluded from matching and the
          reason is recorded. Weight controls how much an optional skill contributes to the score.
        </p>
        {requirements.map((row, index) => (
          <div key={index} className="grid grid-cols-[1fr_6rem_6rem_6rem_2.5rem] items-end gap-2">
            <input
              className="input"
              list="project-skill-options"
              placeholder="Skill name"
              value={row.skillName}
              onChange={(event) => patch(index, { skillName: event.target.value })}
            />
            <select
              className="select"
              aria-label="Requirement type"
              value={row.required ? 'required' : 'optional'}
              onChange={(event) => patch(index, { required: event.target.value === 'required' })}
            >
              <option value="required">Required</option>
              <option value="optional">Optional</option>
            </select>
            <select
              className="select"
              aria-label="Minimum proficiency"
              value={row.minProficiency}
              onChange={(event) => patch(index, { minProficiency: Number(event.target.value) })}
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>
                  min {value}/5
                </option>
              ))}
            </select>
            <select
              className="select"
              aria-label="Weight"
              value={row.weight}
              onChange={(event) => patch(index, { weight: Number(event.target.value) })}
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>
                  weight {value}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              aria-label="Remove requirement"
              onClick={() => setRequirements((rows) => rows.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() =>
            setRequirements((rows) => [
              ...rows,
              { skillName: '', required: false, minProficiency: 2, weight: 2 },
            ])
          }
        >
          Add requirement
        </button>
      </fieldset>

      {error && (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      )}

      <button className="btn btn-primary" type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create project'}
      </button>
    </form>
  );
}
