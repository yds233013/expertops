'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Badge, Card, EmptyState, StatusBadge } from '@/components/ui';

export interface PortalCommitment {
  projectId: string;
  projectCode: string;
  projectTitle: string;
  clientName: string;
  stage: 'ACCEPTED' | 'PROPOSED' | 'CONFIRMED';
  allocationHoursPerWeek: number | null;
  datesLabel: string;
  outstandingWorkItems: number;
  retainedWorkItems: number;
}

export interface PortalWithdrawal {
  projectId: string;
  projectCode: string;
  projectTitle: string;
  withdrawnAtLabel: string | null;
  reason: string | null;
}

const STAGE_LABEL: Record<PortalCommitment['stage'], string> = {
  ACCEPTED: 'Accepted, not yet given a seat',
  PROPOSED: 'Seat proposed, awaiting confirmation',
  CONFIRMED: 'Assigned and confirmed',
};

/**
 * The expert's own withdrawal action.
 *
 * Deliberately two steps. The first click only opens the confirmation, which
 * names the project and spells out what withdrawing does, because this is the
 * one action in the portal an expert cannot undo themselves. The reason box is
 * optional: needing a reason is not a good enough excuse to trap someone on a
 * project.
 */
export function WithdrawalPanel({
  commitments,
  withdrawals,
}: {
  commitments: PortalCommitment[];
  withdrawals: PortalWithdrawal[];
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function open(projectId: string) {
    setConfirming(projectId);
    setReason('');
    setError(null);
  }

  async function withdraw(commitment: PortalCommitment) {
    // Guard the double-click as well as the server: the request is idempotent,
    // but there is no reason to send it twice.
    if (pending) return;
    setPending(commitment.projectId);
    setError(null);
    try {
      const result = await apiPost('/api/portal/withdrawals', {
        projectId: commitment.projectId,
        reason: reason.trim() ? reason.trim() : undefined,
      });
      if (!result.ok) {
        setError(result.error?.message ?? 'Your withdrawal could not be recorded.');
        return;
      }
      setConfirming(null);
      setReason('');
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <Card
      title="Leaving a project"
      description="Withdraw from a project you can no longer do. An operator is told straight away and starts looking for a replacement."
    >
      {commitments.length === 0 ? (
        <EmptyState
          title="No current commitments"
          hint="Projects you have accepted or been assigned to appear here."
        />
      ) : (
        <ul className="space-y-3">
          {commitments.map((commitment) => {
            const isConfirming = confirming === commitment.projectId;
            const busy = pending === commitment.projectId;
            return (
              <li
                key={commitment.projectId}
                className="rounded-lg border border-ink-200 px-3 py-3"
                data-testid={`commitment-${commitment.projectCode}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{commitment.projectCode}</span>
                  <StatusBadge status={commitment.stage} />
                  {commitment.allocationHoursPerWeek !== null && (
                    <Badge tone="muted">{commitment.allocationHoursPerWeek}h/week</Badge>
                  )}
                </div>
                <h3 className="mt-1 text-sm font-semibold text-ink-900">
                  {commitment.projectTitle}
                </h3>
                <p className="text-xs text-ink-500">
                  {commitment.clientName} · {commitment.datesLabel}
                </p>
                <p className="mt-1 text-xs text-ink-500">{STAGE_LABEL[commitment.stage]}</p>

                {isConfirming ? (
                  <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                    <p className="text-xs font-semibold text-amber-900">
                      Withdraw from {commitment.projectCode} · {commitment.projectTitle}?
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-amber-900">
                      {commitment.stage === 'ACCEPTED' ? (
                        <li>Your acceptance is withdrawn and you will not be given a seat.</li>
                      ) : (
                        <li>Your seat is released and given back to the project.</li>
                      )}
                      <li>
                        {commitment.outstandingWorkItems > 0
                          ? `${commitment.outstandingWorkItems} work item(s) still waiting on you are cancelled.`
                          : 'You have no outstanding work items to cancel.'}
                      </li>
                      <li>
                        {commitment.retainedWorkItems > 0
                          ? `Work you already submitted (${commitment.retainedWorkItems} item(s)) is kept, along with any payment already prepared for it.`
                          : 'Any work you have already submitted would be kept.'}
                      </li>
                      <li>You cannot undo this yourself. Ask your contact to be re-invited.</li>
                    </ul>

                    <label
                      className="label mt-2 block"
                      htmlFor={`withdraw-reason-${commitment.projectId}`}
                    >
                      Reason (optional)
                    </label>
                    <input
                      id={`withdraw-reason-${commitment.projectId}`}
                      className="input"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="A client deadline moved onto the same weeks"
                    />

                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={busy}
                        onClick={() => withdraw(commitment)}
                      >
                        {busy ? 'Withdrawing…' : 'Confirm withdrawal'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={busy}
                        onClick={() => setConfirming(null)}
                      >
                        Keep this project
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => open(commitment.projectId)}
                    >
                      Withdraw from this project
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-2 rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}

      {withdrawals.length > 0 && (
        <div className="mt-4 border-t border-ink-100 pt-3">
          <h3 className="text-xs font-semibold text-ink-700">Projects you have withdrawn from</h3>
          <ul className="mt-2 space-y-1.5 text-sm">
            {withdrawals.map((withdrawal) => (
              <li
                key={withdrawal.projectId}
                className="flex flex-wrap items-center justify-between gap-2"
                data-testid={`withdrawn-${withdrawal.projectCode}`}
              >
                <span className="text-ink-800">
                  {withdrawal.projectTitle}{' '}
                  <span className="font-mono text-xs text-ink-500">{withdrawal.projectCode}</span>
                  {withdrawal.withdrawnAtLabel && (
                    <span className="ml-1 text-xs text-ink-500">
                      · {withdrawal.withdrawnAtLabel}
                    </span>
                  )}
                </span>
                <Badge tone="danger">Withdrawn</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
