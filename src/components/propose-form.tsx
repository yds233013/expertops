'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Proposes a seat. Confirming the seat is a separate, explicit operator step. */
export function ProposeForm({
  projectId,
  expertId,
  expertName,
  declaredHours,
  defaultRateCents,
}: {
  projectId: string;
  expertId: string;
  expertName: string;
  declaredHours: number;
  defaultRateCents: number;
}) {
  const router = useRouter();
  const [hours, setHours] = useState(Math.min(declaredHours || 10, 40));
  const [rate, setRate] = useState(defaultRateCents / 100);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/assignments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expertId,
          allocationHoursPerWeek: hours,
          rateCents: Math.round(rate * 100),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error?.message ?? 'The seat could not be proposed.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-28">
          <label className="label" htmlFor={`hours-${expertId}`}>
            h/week
          </label>
          <input
            id={`hours-${expertId}`}
            className="input"
            type="number"
            min={1}
            max={60}
            value={hours}
            onChange={(event) => setHours(Number(event.target.value))}
          />
        </div>
        <div className="w-32">
          <label className="label" htmlFor={`rate-${expertId}`}>
            Rate USD/h
          </label>
          <input
            id={`rate-${expertId}`}
            className="input"
            type="number"
            min={0}
            step={5}
            value={rate}
            onChange={(event) => setRate(Number(event.target.value))}
          />
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={pending}
          onClick={submit}
        >
          {pending ? 'Proposing…' : `Propose ${expertName.split(' ')[0]}`}
        </button>
      </div>
      {declaredHours > 0 && (
        <p className="text-[0.7rem] text-ink-500">Declared availability: {declaredHours} h/week</p>
      )}
      {error && (
        <p role="alert" className="max-w-md rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}
