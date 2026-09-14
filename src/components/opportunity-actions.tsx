'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Alert } from '@/components/ui';

/**
 * Publish and close.
 *
 * Closing asks for a reason before it will do anything, because "why did this
 * stop accepting applications" is the question somebody asks three months later
 * and the activity log is where they will look.
 */
export function OpportunityActions({
  opportunityId,
  status,
}: {
  opportunityId: string;
  status: string;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(body: Record<string, unknown>) {
    setPending(true);
    setError(null);
    try {
      const result = await apiPost(`/api/opportunities/${opportunityId}`, body);
      if (!result.ok) {
        setError(result.error?.message ?? 'That did not work.');
        return;
      }
      setConfirming(false);
      setReason('');
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      {status === 'DRAFT' && (
        <>
          <p className="text-sm text-ink-600">
            A draft is invisible to applicants. Publishing puts it on the opportunities page.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            onClick={() => send({ action: 'publish' })}
          >
            {pending ? 'Publishing…' : 'Publish'}
          </button>
        </>
      )}

      {status === 'PUBLISHED' &&
        (confirming ? (
          <div className="space-y-2">
            <label className="label" htmlFor="close-reason">
              Why is this closing?
            </label>
            <input
              id="close-reason"
              className="input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Seats filled"
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-danger"
                disabled={pending || !reason.trim()}
                onClick={() => send({ action: 'close', reason })}
              >
                {pending ? 'Closing…' : 'Confirm close'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirming(false)}
              >
                Keep it open
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-ink-600">
              Live. Closing stops new applications; the ones already in still stand.
            </p>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirming(true)}>
              Close to new applications
            </button>
          </>
        ))}

      {status === 'CLOSED' && (
        <p className="text-sm text-ink-600">
          Closed. The page still loads for anyone holding the link, and says so.
        </p>
      )}

      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}
