'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPatch } from '@/lib/api-client';

/**
 * Correct the facts on an expert's record.
 *
 * These were write-once until now: an expert entered through `/experts/new`
 * carried whatever was typed then, and an expert *converted from a candidate*
 * by a qualification carried almost nothing at all — the conversion copies a
 * name, an email and a headline, and leaves seniority at zero and the rate
 * empty because a candidate record has nowhere to keep them.
 *
 * That is not cosmetic. Minimum years of experience is a hard filter in
 * matching, so a newly qualified expert with zero years on file is excluded
 * from every project that asks for any, and no screen offered a way to fix it.
 * The route and its validation already existed; this is the form.
 */
export function ExpertProfileEditor({
  expertId,
  initial,
}: {
  expertId: string;
  initial: {
    headline: string;
    yearsExperience: number;
    hourlyRateCents: number;
    timezone: string;
    weeklyCapacityHours: number;
  };
}) {
  const router = useRouter();
  const [headline, setHeadline] = useState(initial.headline);
  const [years, setYears] = useState(String(initial.yearsExperience));
  const [rate, setRate] = useState((initial.hourlyRateCents / 100).toFixed(2));
  const [timezone, setTimezone] = useState(initial.timezone);
  const [capacity, setCapacity] = useState(String(initial.weeklyCapacityHours));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
            headline: headline.trim(),
            yearsExperience: Number(years),
            // Money is an integer count of minor units everywhere it is stored.
            hourlyRateCents: Math.round(Number(rate) * 100),
            timezone: timezone.trim(),
            weeklyCapacityHours: Number(capacity),
          });
          if (!result.ok) {
            setError(result.error?.message ?? 'The profile could not be saved.');
            return;
          }
          setNotice('Profile saved.');
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
    >
      <div>
        <label className="label" htmlFor="expert-headline">
          Headline
        </label>
        <input
          id="expert-headline"
          className="input"
          value={headline}
          onChange={(event) => setHeadline(event.target.value)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="expert-years">
            Years of experience
          </label>
          <input
            id="expert-years"
            className="input"
            type="number"
            min={0}
            max={60}
            value={years}
            onChange={(event) => setYears(event.target.value)}
          />
          <p className="field-hint">
            A hard filter in matching. Zero excludes them from any project asking for more.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="expert-rate">
            Hourly rate
          </label>
          <input
            id="expert-rate"
            className="input"
            type="number"
            min={0}
            step="0.01"
            value={rate}
            onChange={(event) => setRate(event.target.value)}
          />
          <p className="field-hint">Scores against a project ceiling; it never excludes.</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="expert-timezone">
            Timezone
          </label>
          <input
            id="expert-timezone"
            className="input"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
          />
          <p className="field-hint">Scheduling only. Never a proxy for anything about a person.</p>
        </div>
        <div>
          <label className="label" htmlFor="expert-capacity">
            Weekly capacity
          </label>
          <input
            id="expert-capacity"
            className="input"
            type="number"
            min={0}
            max={60}
            value={capacity}
            onChange={(event) => setCapacity(event.target.value)}
          />
          <p className="field-hint">
            What they say they can take on. Declared availability is what staffing actually uses.
          </p>
        </div>
      </div>

      {error && (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="alert alert-success">
          {notice}
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? 'Saving…' : 'Save profile'}
      </button>
    </form>
  );
}
