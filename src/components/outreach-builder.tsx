'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Badge, EmptyState } from '@/components/ui';

export interface RecipientOption {
  expertId: string;
  fullName: string;
  reference: string;
  status: string;
  rationale: string;
  matchScore: number | null;
  /** Set when this person cannot currently be invited; shown, not hidden. */
  blocker: string | null;
}

/**
 * Assemble a batch and preview it before anyone approves anything.
 *
 * The preview is the DRAFT batch itself: recipients are chosen here, the batch
 * is created in DRAFT, and the detail page shows exactly who is in it. Nothing
 * is sent by this form — a batch has to be submitted, approved by an operator
 * with the approval capability, and then dispatched.
 *
 * People who currently cannot be invited are listed with the reason rather than
 * filtered out, because "why is this person missing" is the first question an
 * operator asks. They can still be included: eligibility is re-checked at
 * dispatch, by the invitation service, and may have changed by then.
 */
export function OutreachBuilder({
  projectId,
  projectLabel,
  recipients,
}: {
  projectId: string;
  projectLabel: string;
  recipients: RecipientOption[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>(
    recipients.filter((person) => !person.blocker).map((person) => person.expertId),
  );
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (recipients.length === 0) {
    return (
      <EmptyState
        title="Nobody to contact for this project"
        hint="Run matching on the project first; the ranked candidates appear here."
      />
    );
  }

  function toggle(expertId: string, on: boolean) {
    setSelected((previous) =>
      on ? [...previous, expertId] : previous.filter((id) => id !== expertId),
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        try {
          const result = await apiPost<{ batch: { id: string } }>('/api/outreach-batches', {
            kind: 'PROJECT_INVITATION',
            projectId,
            reason,
            items: selected.map((expertId) => {
              const person = recipients.find((candidate) => candidate.expertId === expertId);
              return {
                expertId,
                rationale: person?.rationale || undefined,
                matchScore: person?.matchScore ?? null,
              };
            }),
          });
          if (!result.ok) {
            setError(result.error?.message ?? 'The batch could not be assembled.');
            return;
          }
          router.push(`/outreach/${result.data!.batch.id}`);
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
    >
      <div>
        <label htmlFor="outreach-reason" className="label">
          Why these people, and what to say
        </label>
        <textarea
          id="outreach-reason"
          rows={2}
          className="input"
          placeholder="Included in the invitation each recipient receives."
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>

      <fieldset>
        <legend className="text-xs font-semibold text-ink-700">
          Recipients for {projectLabel}
        </legend>
        <ul className="mt-2 space-y-1">
          {recipients.map((person) => (
            <li key={person.expertId}>
              <label className="flex flex-wrap items-center gap-2 rounded-md border border-ink-200 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(person.expertId)}
                  onChange={(event) => toggle(person.expertId, event.target.checked)}
                />
                <span className="font-medium text-ink-900">{person.fullName}</span>
                <span className="font-mono text-xs text-ink-500">{person.reference}</span>
                {person.matchScore !== null && <Badge tone="info">score {person.matchScore}</Badge>}
                {person.blocker ? (
                  <Badge tone="warning">{person.blocker}</Badge>
                ) : (
                  <Badge tone="muted">eligible now</Badge>
                )}
                {person.rationale && (
                  <span className="basis-full text-xs text-ink-600">{person.rationale}</span>
                )}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      {error && (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      )}

      <p className="text-xs text-ink-600">
        Assembling a list sends nothing. The batch is created as a draft, and an operator with
        approval rights has to approve it before it can be dispatched.
      </p>

      <button type="submit" className="btn btn-primary" disabled={pending || selected.length === 0}>
        {pending ? 'Assembling…' : `Preview a batch of ${selected.length}`}
      </button>
    </form>
  );
}
