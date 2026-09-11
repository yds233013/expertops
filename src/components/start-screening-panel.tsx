'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

/**
 * Start a screening against a published rubric version.
 *
 * Only published versions are offered: a draft cannot be screened against,
 * because the criteria could still change underneath the candidate.
 */
export function StartScreeningPanel({
  candidateId,
  versions,
}: {
  candidateId: string;
  versions: Array<{ id: string; label: string }>;
}) {
  const router = useRouter();
  const [versionId, setVersionId] = useState(versions[0]?.id ?? '');
  const [dueInHours, setDueInHours] = useState(168);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    const result = await apiPost(`/api/candidates/${candidateId}`, {
      action: 'start_screening',
      rubricVersionId: versionId,
      dueInHours,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error?.message ?? 'The screening could not be started.');
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-2 rounded-lg border border-ink-200 px-3 py-3">
      <p className="text-xs font-semibold text-ink-800">Start a screening</p>

      <div>
        <label className="label" htmlFor={`rubric-${candidateId}`}>
          Published rubric version
        </label>
        <select
          id={`rubric-${candidateId}`}
          className="select"
          value={versionId}
          onChange={(event) => setVersionId(event.target.value)}
        >
          {versions.map((version) => (
            <option key={version.id} value={version.id}>
              {version.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor={`due-${candidateId}`}>
          Submit within
        </label>
        <select
          id={`due-${candidateId}`}
          className="select"
          value={dueInHours}
          onChange={(event) => setDueInHours(Number(event.target.value))}
        >
          <option value={72}>3 days</option>
          <option value={168}>7 days</option>
          <option value={336}>14 days</option>
        </select>
      </div>

      {error && (
        <p role="alert" className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}

      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={pending || !versionId}
        onClick={start}
      >
        {pending ? 'Starting…' : 'Send screening'}
      </button>
      <p className="text-[0.7rem] text-ink-500">
        The worker renders the invitation into the simulated outbox. Nothing is emailed.
      </p>
    </div>
  );
}
