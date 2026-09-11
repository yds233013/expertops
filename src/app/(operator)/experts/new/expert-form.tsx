'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface SkillRow {
  name: string;
  proficiency: number;
  yearsUsed: number;
}

export function ExpertForm({
  skillNames,
  timezones,
}: {
  skillNames: string[];
  timezones: string[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillRow[]>([{ name: '', proficiency: 3, yearsUsed: 2 }]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);

    const payload = {
      fullName: String(form.get('fullName') ?? '').trim(),
      email: String(form.get('email') ?? '').trim(),
      headline: String(form.get('headline') ?? '').trim(),
      bio: String(form.get('bio') ?? '').trim() || undefined,
      yearsExperience: Number(form.get('yearsExperience') ?? 0),
      timezone: String(form.get('timezone') ?? 'UTC'),
      hourlyRateCents: Math.round(Number(form.get('hourlyRate') ?? 0) * 100),
      weeklyCapacityHours: Number(form.get('weeklyCapacityHours') ?? 0),
      skills: skills
        .filter((skill) => skill.name.trim().length > 0)
        .map((skill) => ({
          name: skill.name.trim(),
          proficiency: skill.proficiency,
          yearsUsed: skill.yearsUsed,
        })),
    };

    try {
      const response = await fetch('/api/experts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? 'The expert could not be created.');
        return;
      }
      router.push(`/experts/${body.expert.id}`);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card space-y-4 px-4 py-4" onSubmit={onSubmit}>
      <datalist id="skill-options">
        {skillNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="fullName">
            Full name
          </label>
          <input id="fullName" name="fullName" className="input" required maxLength={160} />
        </div>
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input id="email" name="email" type="email" className="input" required />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="headline">
          Headline
        </label>
        <input
          id="headline"
          name="headline"
          className="input"
          required
          maxLength={200}
          placeholder="Principal Consultant — payments platforms"
        />
      </div>

      <div>
        <label className="label" htmlFor="bio">
          Background
        </label>
        <textarea id="bio" name="bio" className="textarea" rows={3} maxLength={4000} />
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className="label" htmlFor="yearsExperience">
            Years experience
          </label>
          <input
            id="yearsExperience"
            name="yearsExperience"
            type="number"
            min={0}
            max={60}
            defaultValue={8}
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor="hourlyRate">
            Rate (USD/hour)
          </label>
          <input
            id="hourlyRate"
            name="hourlyRate"
            type="number"
            min={0}
            max={10000}
            step={5}
            defaultValue={200}
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor="weeklyCapacityHours">
            Capacity (h/week)
          </label>
          <input
            id="weeklyCapacityHours"
            name="weeklyCapacityHours"
            type="number"
            min={0}
            max={60}
            defaultValue={20}
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor="timezone">
            Working timezone
          </label>
          <select id="timezone" name="timezone" className="select" defaultValue="UTC">
            {timezones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="label">Skills</legend>
        {skills.map((skill, index) => (
          <div key={index} className="grid grid-cols-[1fr_6rem_6rem_2.5rem] gap-2">
            <input
              className="input"
              list="skill-options"
              placeholder="Skill name"
              value={skill.name}
              onChange={(event) =>
                setSkills((rows) =>
                  rows.map((row, i) => (i === index ? { ...row, name: event.target.value } : row)),
                )
              }
            />
            <select
              className="select"
              value={skill.proficiency}
              aria-label="Proficiency"
              onChange={(event) =>
                setSkills((rows) =>
                  rows.map((row, i) =>
                    i === index ? { ...row, proficiency: Number(event.target.value) } : row,
                  ),
                )
              }
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>
                  {value}/5
                </option>
              ))}
            </select>
            <input
              className="input"
              type="number"
              min={0}
              max={60}
              aria-label="Years used"
              value={skill.yearsUsed}
              onChange={(event) =>
                setSkills((rows) =>
                  rows.map((row, i) =>
                    i === index ? { ...row, yearsUsed: Number(event.target.value) } : row,
                  ),
                )
              }
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              aria-label="Remove skill"
              onClick={() => setSkills((rows) => rows.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setSkills((rows) => [...rows, { name: '', proficiency: 3, yearsUsed: 2 }])}
        >
          Add skill
        </button>
      </fieldset>

      {error && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      )}

      <button className="btn btn-primary" type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Create expert'}
      </button>
    </form>
  );
}
