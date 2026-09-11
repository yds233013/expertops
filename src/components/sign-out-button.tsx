'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await apiPost('/api/auth/logout');
        router.replace('/login');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
