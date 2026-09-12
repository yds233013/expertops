'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { apiPost } from '@/lib/api-client';

/**
 * Magic-link landing that keeps the token out of every HTTP request.
 *
 * The link is `/apply/enter#t=<token>` or `/portal/enter#t=<token>`. A URL
 * fragment is not transmitted: the browser strips it before sending the
 * request, so the landing GET, the server's access log, and any `Referer`
 * this page produces contain only the path.
 *
 * The sequence is deliberate:
 *
 *  1. Read the fragment, then immediately remove it with `replaceState`, so it
 *     does not survive in the address bar, in history, or in anything a later
 *     script reads.
 *  2. Exchange it with a POST, so the secret is in a request body rather than a
 *     URL, and so a prefetch or a link preview (both of which issue GETs)
 *     cannot consume a single-use token.
 *
 * Removing the fragment is a tidiness measure, not the protection. The
 * protection is that the fragment never left the browser in the first place.
 */
export function FragmentEntry({
  endpoint,
  destination,
  audience,
}: {
  /** Session endpoint that redeems the token. */
  endpoint: string;
  /** Where to go once a session exists. */
  destination: string;
  audience: 'screening' | 'portal';
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const hash = window.location.hash ?? '';
    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    const token = params.get('t');

    // Strip the fragment before anything else happens on this page.
    if (hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    if (!token) {
      setMissing(true);
      return;
    }

    void (async () => {
      const result = await apiPost(endpoint, { token });
      if (!result.ok) {
        setError(result.error?.message ?? 'This link could not be opened.');
        return;
      }
      router.replace(destination);
      router.refresh();
    })();
  }, [endpoint, destination, router]);

  const noun = audience === 'screening' ? 'Screening links' : 'Portal links';

  if (missing) {
    return (
      <div className="card px-4 py-5">
        <h1 className="text-base font-semibold text-ink-900">This link is incomplete</h1>
        <p role="alert" className="mt-2 text-sm text-ink-700">
          It is missing the part that identifies you. That happens when a link is retyped by hand or
          truncated by a mail client.
        </p>
        <p className="mt-3 text-xs text-ink-500">
          Open the most recent link exactly as it was sent, or ask your ExpertOps contact for a new
          one.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card px-4 py-5">
        <h1 className="text-base font-semibold text-ink-900">This link cannot be opened</h1>
        <p role="alert" className="mt-2 text-sm text-ink-700">
          {error}
        </p>
        <p className="mt-3 text-xs text-ink-500">
          {noun} are single-use and expire. Ask your ExpertOps contact to send a new one.
        </p>
      </div>
    );
  }

  return (
    <div className="card px-4 py-5">
      <p className="text-sm text-ink-600" role="status">
        Opening…
      </p>
    </div>
  );
}
