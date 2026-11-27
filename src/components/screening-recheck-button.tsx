'use client';

import { useState } from 'react';
import { ActionButton } from '@/components/action-button';

/**
 * Queue a fresh check of the latest submission.
 *
 * The check runs on the worker, so the result is not here when the request
 * returns. Saying so stops a reviewer reading the old result as the new one.
 */
export function ScreeningRecheckButton({ screeningId }: { screeningId: string }) {
  const [queued, setQueued] = useState(false);
  return (
    <div className="flex flex-col items-end gap-1">
      <ActionButton
        url={`/api/screenings/${screeningId}/check`}
        label="Check again"
        pendingLabel="Queueing…"
        onDone={() => setQueued(true)}
      />
      {queued && (
        <p role="status" className="text-xs text-ink-600">
          Queued. The new result replaces this one within a minute; reload to see it.
        </p>
      )}
    </div>
  );
}
