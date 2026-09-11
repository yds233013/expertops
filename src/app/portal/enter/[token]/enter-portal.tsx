'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { apiPost } from '@/lib/api-client';

export function EnterPortal({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void (async () => {
      try {
        const result = await apiPost('/api/portal/session', { token });
        if (!result.ok) {
          setError(result.error?.message ?? 'This link could not be opened.');
          return;
        }
        router.replace('/portal');
        router.refresh();
      } catch {
        setError('Could not reach the server.');
      }
    })();
  }, [router, token]);

  if (error) {
    return (
      <div className="card px-4 py-5">
        <h1 className="text-base font-semibold text-ink-900">Link not usable</h1>
        <p className="mt-2 text-sm text-ink-600">{error}</p>
        <p className="mt-3 text-xs text-ink-500">
          Portal links are single-use and expire. Ask your ExpertOps contact to send a new one.
        </p>
      </div>
    );
  }

  return (
    <div className="card px-4 py-5">
      <p className="text-sm text-ink-600">Opening your portal…</p>
    </div>
  );
}
