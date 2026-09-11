'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

/**
 * Assign a piece of work to a confirmed seat.
 *
 * Only confirmed assignments are offered, because the service refuses anything
 * else. The basis matters: an hourly item makes the expert declare hours, and
 * payment preparation compares those hours against what was approved.
 */
export function AssignWorkPanel({ assignments }: { assignments: { id: string; label: string }[] }) {
  const router = useRouter();
  const [assignmentId, setAssignmentId] = useState(assignments[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [basis, setBasis] = useState<'DELIVERABLE' | 'HOURLY'>('HOURLY');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (assignments.length === 0) {
    return (
      <p className="text-sm text-ink-600">
        No confirmed seats yet. Work can only be assigned once someone is staffed.
      </p>
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
          const result = await apiPost('/api/work-items', {
            assignmentId,
            title,
            instructions: instructions || undefined,
            basis,
          });
          if (!result.ok) {
            setError(result.error?.message ?? 'The work item could not be created.');
            return;
          }
          setTitle('');
          setInstructions('');
          setNotice('Work assigned. It now appears in the expert’s portal.');
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="work-assignment" className="text-xs font-semibold text-ink-700">
            Staffed seat
          </label>
          <select
            id="work-assignment"
            className="input mt-1 w-full"
            value={assignmentId}
            onChange={(event) => setAssignmentId(event.target.value)}
          >
            {assignments.map((assignment) => (
              <option key={assignment.id} value={assignment.id}>
                {assignment.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="work-title" className="text-xs font-semibold text-ink-700">
            Title
          </label>
          <input
            id="work-title"
            className="input mt-1 w-full"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="work-basis" className="text-xs font-semibold text-ink-700">
            Basis
          </label>
          <select
            id="work-basis"
            className="input mt-1 w-full"
            value={basis}
            onChange={(event) => setBasis(event.target.value as 'DELIVERABLE' | 'HOURLY')}
          >
            <option value="HOURLY">Hourly</option>
            <option value="DELIVERABLE">Deliverable</option>
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="work-instructions" className="text-xs font-semibold text-ink-700">
          Instructions
        </label>
        <textarea
          id="work-instructions"
          rows={3}
          className="input mt-1 w-full"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </div>

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
        {pending ? 'Assigning…' : 'Assign work'}
      </button>
    </form>
  );
}
