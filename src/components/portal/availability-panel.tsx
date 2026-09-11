'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Card, EmptyState } from '@/components/ui';
import { apiDelete, apiPost } from '@/lib/api-client';

interface WindowRow {
  id: string;
  startAt: string;
  endAt: string;
  hoursPerWeek: number;
  note: string;
  projectLabel: string | null;
}

function formatDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export function AvailabilityPanel({
  windows,
  projects,
}: {
  windows: WindowRow[];
  projects: Array<{ id: string; label: string }>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const projectId = String(form.get('projectId') ?? '');

    try {
      const result = await apiPost('/api/portal/availability', {
        startAt: String(form.get('startAt') ?? ''),
        endAt: String(form.get('endAt') ?? ''),
        hoursPerWeek: Number(form.get('hoursPerWeek') ?? 0),
        projectId: projectId || null,
        note: String(form.get('note') ?? '').trim() || undefined,
      });
      if (!result.ok) {
        setError(result.error?.message ?? 'That window could not be saved.');
        return;
      }
      formElement.reset();
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    const result = await apiDelete(`/api/portal/availability/${id}`);
    if (!result.ok) {
      setError(result.error?.message ?? 'That window could not be removed.');
      return;
    }
    router.refresh();
  }

  return (
    <Card
      title="Your availability"
      description="Staffing uses this. A seat cannot be allocated for more hours than you declare."
    >
      {windows.length === 0 ? (
        <EmptyState title="No availability on file" hint="Add a window below." />
      ) : (
        <ul className="mb-4 space-y-1.5 text-sm">
          {windows.map((window) => (
            <li key={window.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-ink-800">
                {formatDay(window.startAt)} → {formatDay(window.endAt)} ·{' '}
                <strong className="tabular-nums">{window.hoursPerWeek} h/week</strong>
                {window.projectLabel && (
                  <span className="text-ink-500"> · {window.projectLabel}</span>
                )}
                {window.note && <span className="text-ink-500"> · {window.note}</span>}
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => remove(window.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="grid gap-3 sm:grid-cols-5" onSubmit={add}>
        <div>
          <label className="label" htmlFor="startAt">
            From
          </label>
          <input id="startAt" name="startAt" type="date" className="input" required />
        </div>
        <div>
          <label className="label" htmlFor="endAt">
            To
          </label>
          <input id="endAt" name="endAt" type="date" className="input" required />
        </div>
        <div>
          <label className="label" htmlFor="hoursPerWeek">
            Hours/week
          </label>
          <input
            id="hoursPerWeek"
            name="hoursPerWeek"
            type="number"
            min={1}
            max={60}
            defaultValue={20}
            className="input"
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="projectId">
            For project
          </label>
          <select id="projectId" name="projectId" className="select" defaultValue="">
            <option value="">General</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <button className="btn btn-primary w-full" type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Add window'}
          </button>
        </div>
        <div className="sm:col-span-5">
          <label className="label" htmlFor="note">
            Note (optional)
          </label>
          <input id="note" name="note" className="input" maxLength={500} />
        </div>
      </form>

      {error && (
        <p role="alert" className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      )}
    </Card>
  );
}
