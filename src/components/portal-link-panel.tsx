'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

/**
 * Issue an expert a new way into their portal.
 *
 * The link itself is deliberately not shown here. It goes to the simulated
 * outbox like every other portal link, so there is one place an operator reads
 * them from and one place the history records them.
 */
export function PortalLinkPanel({
  expertId,
  expertName,
}: {
  expertId: string;
  expertName: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <p className="text-sm text-ink-600">
        Portal links work once. If {expertName} has lost theirs, issue another — it arrives in the
        simulated outbox, where you can read it back to them.
      </p>
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
      <button
        type="button"
        className="btn btn-secondary"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          setNotice(null);
          try {
            const result = await apiPost(`/api/experts/${expertId}/portal-link`, {});
            if (!result.ok) {
              setError(result.error?.message ?? 'The portal link could not be issued.');
              return;
            }
            setNotice('A new portal link is in the outbox. The old one no longer works.');
            router.refresh();
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Issuing…' : 'Issue a new portal link'}
      </button>
    </div>
  );
}
