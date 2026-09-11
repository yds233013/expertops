'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { apiPost } from '@/lib/api-client';

export function EnterApplication({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void (async () => {
      const result = await apiPost('/api/apply/session', { token });
      if (!result.ok) {
        setError(result.error?.message ?? 'This link could not be opened.');
        return;
      }
      // `replace` keeps the token out of browser history.
      router.replace('/apply');
      router.refresh();
    })();
  }, [router, token]);

  if (error) {
    return (
      <div className="card px-4 py-5">
        <h1 className="text-base font-semibold text-ink-900">This link cannot be opened</h1>
        <p role="alert" className="mt-2 text-sm text-ink-700">
          {error}
        </p>
        <p className="mt-3 text-xs text-ink-500">
          Screening links are single-use and expire. Ask your ExpertOps contact to send a new one.
        </p>
      </div>
    );
  }

  return (
    <div className="card px-4 py-5">
      <p className="text-sm text-ink-600" role="status">
        Opening your screening…
      </p>
    </div>
  );
}
