'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Alert } from '@/components/ui';

/**
 * Withdraw an application.
 *
 * Asks once, in plain words, and says what withdrawing does and does not do.
 * The server scopes the change to the session's own candidate, so this control
 * cannot reach anybody else's application however it is called.
 */
export function WithdrawApplicationButton({
  applicationId,
  title,
}: {
  applicationId: string;
  title: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!confirming) {
    return (
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => setConfirming(true)}
      >
        Withdraw this application
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
      <p className="text-sm font-semibold text-amber-900">Withdraw from {title}?</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-amber-900">
        <li>We stop considering you for this one.</li>
        <li>Anything you already submitted is kept, not deleted.</li>
        <li>You can apply again later while it is still open.</li>
      </ul>
      <label className="label mt-2" htmlFor={`withdraw-${applicationId}`}>
        Reason (optional)
      </label>
      <input
        id={`withdraw-${applicationId}`}
        className="input"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {error && (
        <Alert tone="error" className="mt-2">
          {error}
        </Alert>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            setError(null);
            try {
              const result = await apiPost(`/api/apply/applications/${applicationId}`, {
                action: 'withdraw',
                reason: reason || undefined,
              });
              if (!result.ok) {
                setError(result.error?.message ?? 'That did not work.');
                return;
              }
              setConfirming(false);
              router.refresh();
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? 'Withdrawing…' : 'Confirm withdrawal'}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setConfirming(false)}
        >
          Keep it
        </button>
      </div>
    </div>
  );
}
