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
 *
 * The due date is optional to the API but not decorative: `work.remind_overdue`
 * selects on `dueAt <= now`, so an item created without one can never be
 * reported late. This form used to omit the field entirely, which meant every
 * work item an operator created was invisible to that sweep.
 */
export function AssignWorkPanel({ assignments }: { assignments: { id: string; label: string }[] }) {
  const router = useRouter();
  const [assignmentId, setAssignmentId] = useState(assignments[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [basis, setBasis] = useState<'DELIVERABLE' | 'HOURLY'>('HOURLY');
  const [dueAt, setDueAt] = useState('');
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
            // A date input yields 'YYYY-MM-DD', which parses as UTC midnight —
            // the start of the day, not the end of it. End of day is what an
            // operator means by "due on the 20th".
            dueAt: dueAt ? new Date(`${dueAt}T23:59:59.999Z`).toISOString() : undefined,
          });
          if (!result.ok) {
            setError(result.error?.message ?? 'The work item could not be created.');
            return;
          }
          setTitle('');
          setInstructions('');
          setDueAt('');
          setNotice('Work assigned. It now appears in the expert’s portal.');
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="work-assignment" className="label">
            Staffed seat
          </label>
          <select
            id="work-assignment"
            className="select"
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
          <label htmlFor="work-title" className="label">
            Title
          </label>
          <input
            id="work-title"
            className="input"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="work-basis" className="label">
            Basis
          </label>
          <select
            id="work-basis"
            className="select"
            value={basis}
            onChange={(event) => setBasis(event.target.value as 'DELIVERABLE' | 'HOURLY')}
          >
            <option value="HOURLY">Hourly</option>
            <option value="DELIVERABLE">Deliverable</option>
          </select>
        </div>
        <div>
          <label htmlFor="work-due" className="label">
            Due date
          </label>
          <input
            id="work-due"
            type="date"
            className="input"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
          <p className="mt-1 text-xs text-ink-500">
            Without one, the item is never reported as overdue.
          </p>
        </div>
      </div>

      <div>
        <label htmlFor="work-instructions" className="label">
          Instructions
        </label>
        <textarea
          id="work-instructions"
          rows={3}
          className="input"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
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
        {pending ? 'Assigning…' : 'Assign work'}
      </button>
    </form>
  );
}
