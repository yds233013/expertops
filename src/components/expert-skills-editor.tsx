'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPatch } from '@/lib/api-client';

interface SkillRow {
  name: string;
  proficiency: number;
  yearsUsed: number;
}

/**
 * Record what an expert can actually do.
 *
 * This matters beyond bookkeeping: a project's required skills are a hard
 * filter, so an expert with no skills recorded is excluded from every match.
 * A newly qualified expert therefore needs this before they can be staffed.
 */
export function ExpertSkillsEditor({
  expertId,
  initial,
  skillNames,
}: {
  expertId: string;
  initial: SkillRow[];
  skillNames: string[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState<SkillRow[]>(
    initial.length > 0 ? initial : [{ name: '', proficiency: 3, yearsUsed: 2 }],
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function patch(index: number, change: Partial<SkillRow>) {
    setRows((previous) =>
      previous.map((row, position) => (position === index ? { ...row, ...change } : row)),
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        setNotice(null);
        try {
          const result = await apiPatch(`/api/experts/${expertId}`, {
            skills: rows
              .filter((row) => row.name.trim().length > 0)
              .map((row) => ({
                name: row.name.trim(),
                proficiency: row.proficiency,
                yearsUsed: row.yearsUsed,
              })),
          });
          if (!result.ok) {
            setError(result.error?.message ?? 'The skills could not be saved.');
            return;
          }
          setNotice('Skills saved.');
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
    >
      <datalist id="expert-skill-options">
        {skillNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-[1fr_7rem_7rem_2.5rem] items-end gap-2">
          <div>
            <label className="label" htmlFor={`skill-name-${index}`}>
              Skill
            </label>
            <input
              id={`skill-name-${index}`}
              className="input"
              list="expert-skill-options"
              placeholder="Skill name"
              value={row.name}
              onChange={(event) => patch(index, { name: event.target.value })}
            />
          </div>
          <div>
            <label className="label" htmlFor={`skill-proficiency-${index}`}>
              Proficiency
            </label>
            <select
              id={`skill-proficiency-${index}`}
              className="select"
              value={row.proficiency}
              onChange={(event) => patch(index, { proficiency: Number(event.target.value) })}
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>
                  {value}/5
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={`skill-years-${index}`}>
              Years used
            </label>
            <input
              id={`skill-years-${index}`}
              type="number"
              min={0}
              max={60}
              className="input"
              value={row.yearsUsed}
              onChange={(event) => patch(index, { yearsUsed: Number(event.target.value) })}
            />
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-label={`Remove ${row.name || 'skill'}`}
            onClick={() => setRows((previous) => previous.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}

      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() =>
          setRows((previous) => [...previous, { name: '', proficiency: 3, yearsUsed: 2 }])
        }
      >
        Add skill
      </button>

      {error && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? 'Saving…' : 'Save skills'}
      </button>
    </form>
  );
}
