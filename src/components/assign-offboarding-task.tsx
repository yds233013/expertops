'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

/**
 * Give an offboarding task an owner.
 *
 * Checklists opened automatically when a project closes have no owner: the
 * worker is not a person who can be held to one. Rather than assigning someone
 * arbitrarily, those tasks sit in the unassigned queue until an operator takes
 * them, which is what this control is for.
 */
export function AssignOffboardingTask({
  taskId,
  ownerId,
  owners,
  canAssign,
}: {
  taskId: string;
  ownerId: string | null;
  owners: { id: string; name: string }[];
  canAssign: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canAssign) {
    return (
      <span className="text-xs text-ink-600">
        {ownerId
          ? (owners.find((owner) => owner.id === ownerId)?.name ?? 'assigned')
          : 'unassigned'}
      </span>
    );
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <label className="sr-only" htmlFor={`offboard-owner-${taskId}`}>
        Owner for this offboarding task
      </label>
      <select
        id={`offboard-owner-${taskId}`}
        className="input"
        value={ownerId ?? ''}
        disabled={pending}
        onChange={async (event) => {
          const value = event.target.value;
          setPending(true);
          setError(null);
          try {
            const result = await apiPost(`/api/offboarding-tasks/${taskId}`, {
              action: 'assign',
              ownerId: value || null,
            });
            if (!result.ok) {
              setError(result.error?.message ?? 'The owner could not be changed.');
              return;
            }
            router.refresh();
          } finally {
            setPending(false);
          }
        }}
      >
        <option value="">Unassigned</option>
        {owners.map((owner) => (
          <option key={owner.id} value={owner.id}>
            {owner.name}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}
