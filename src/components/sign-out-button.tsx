'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch } from '@/lib/api-client';

/**
 * Ends a session and returns to a safe page.
 *
 * Parameterised because the three audiences end their sessions at different
 * endpoints: operators post to the auth route, portal users delete their own
 * session cookie.
 */
export function SignOutButton({
  url = '/api/auth/logout',
  method = url === '/api/auth/logout' ? 'POST' : 'DELETE',
  redirectTo = '/login',
  label = 'Sign out',
}: {
  url?: string;
  method?: 'POST' | 'DELETE';
  redirectTo?: string;
  label?: string;
} = {}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await apiFetch(url, { method });
        router.replace(redirectTo);
        router.refresh();
      }}
    >
      {pending ? 'Signing out…' : label}
    </button>
  );
}
