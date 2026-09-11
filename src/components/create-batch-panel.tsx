'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

export interface ReadyItem {
  id: string;
  reference: string;
  label: string;
  amount: string;
}

/**
 * Gather ready items into a batch for approval.
 *
 * Nothing here moves money. The batch is a proposal that someone other than its
 * creator has to approve, and the service enforces that separation rather than
 * this form hiding the button.
 */
export function CreateBatchPanel({ items }: { items: ReadyItem[] }) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;

  const [selected, setSelected] = useState<string[]>(items.map((item) => item.id));
  const [periodStart, setPeriodStart] = useState(monthStart);
  const [periodEnd, setPeriodEnd] = useState(today);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (items.length === 0) return null;

  return (
    <form
      className="space-y-3 border-t border-ink-100 pt-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        try {
          const result = await apiPost('/api/payment-batches', {
            periodStart,
            periodEnd,
            itemIds: selected,
          });
          if (!result.ok) {
            setError(result.error?.message ?? 'The batch could not be created.');
            return;
          }
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
    >
      <h3 className="text-sm font-semibold text-ink-900">Create a batch</h3>

      <fieldset>
        <legend className="text-xs font-semibold text-ink-700">Items to include</legend>
        <ul className="mt-1 space-y-1">
          {items.map((item) => (
            <li key={item.id}>
              <label className="flex items-center gap-2 text-sm text-ink-800">
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  onChange={(event) =>
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, item.id]
                        : previous.filter((id) => id !== item.id),
                    )
                  }
                />
                <span className="font-mono text-xs">{item.reference}</span>
                {item.label}
                <span className="tabular-nums font-semibold">{item.amount}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="period-start" className="text-xs font-semibold text-ink-700">
            Period start
          </label>
          <input
            id="period-start"
            type="date"
            className="input mt-1 w-full"
            value={periodStart}
            onChange={(event) => setPeriodStart(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="period-end" className="text-xs font-semibold text-ink-700">
            Period end
          </label>
          <input
            id="period-end"
            type="date"
            className="input mt-1 w-full"
            value={periodEnd}
            onChange={(event) => setPeriodEnd(event.target.value)}
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={pending || selected.length === 0}>
        {pending ? 'Creating…' : `Create batch of ${selected.length}`}
      </button>
    </form>
  );
}
