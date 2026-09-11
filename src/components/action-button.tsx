'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { clsx } from 'clsx';

/**
 * A button that POSTs to an API route and surfaces the server's error message.
 *
 * The UI never decides whether an action is allowed - it asks, and renders the
 * domain error the service returned. That is what keeps the rules in one place.
 */
export function ActionButton({
  url,
  body,
  method = 'POST',
  label,
  pendingLabel,
  variant = 'secondary',
  size = 'sm',
  confirm,
  onDone,
  disabled,
  children,
}: {
  url: string;
  body?: unknown;
  method?: 'POST' | 'PATCH' | 'DELETE';
  label: string;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md';
  confirm?: string;
  onDone?: () => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function run() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? `Request failed (${response.status}).`);
        return;
      }
      setConfirming(false);
      onDone?.();
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending || disabled}
          className={clsx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm')}
          onClick={() => {
            if (confirm && !confirming) {
              setConfirming(true);
              return;
            }
            void run();
          }}
        >
          {pending ? (pendingLabel ?? 'Working…') : confirming ? `Confirm: ${label}` : label}
        </button>
        {confirming && !pending && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        )}
        {children}
      </div>
      {confirming && confirm && <p className="text-xs text-ink-600">{confirm}</p>}
      {error && (
        <p role="alert" className="max-w-md rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}
