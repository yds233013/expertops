'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Badge, Card, EmptyState, StatusBadge } from '@/components/ui';

export interface PortalWorkItem {
  id: string;
  reference: string;
  title: string;
  instructions: string;
  basis: string;
  status: string;
  dueAt: string | null;
  projectLabel: string;
  lastSubmission: {
    revision: number;
    summary: string;
    content: string;
    hoursClaimed: string | null;
  } | null;
  revisionRequest: string | null;
  reviewSummary: string | null;
}

/**
 * The expert's delivery panel.
 *
 * A revision request is shown as the first thing on the item, because it is the
 * only reason the expert is looking at an item they already submitted.
 */
export function WorkPanel({ items }: { items: PortalWorkItem[] }) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<
    Record<string, { content: string; summary: string; hours: string }>
  >(() =>
    Object.fromEntries(
      items.map((item) => [
        item.id,
        {
          content: item.lastSubmission?.content ?? '',
          summary: item.lastSubmission?.summary ?? '',
          hours: item.lastSubmission?.hoursClaimed ?? '',
        },
      ]),
    ),
  );
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function patch(id: string, change: Partial<{ content: string; summary: string; hours: string }>) {
    setDrafts((previous) => ({ ...previous, [id]: { ...previous[id]!, ...change } }));
  }

  async function submit(item: PortalWorkItem) {
    const draft = drafts[item.id]!;
    setPending(item.id);
    setError(null);
    try {
      const result = await apiPost(`/api/portal/work/${item.id}`, {
        content: draft.content,
        summary: draft.summary || undefined,
        hoursClaimed: item.basis === 'HOURLY' ? draft.hours : undefined,
      });
      if (!result.ok) {
        setError(result.error?.message ?? 'Your work could not be submitted.');
        return;
      }
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <Card
      title="Your work"
      description="Submit what you have done. An operator reviews it before it reaches payment preparation."
    >
      {items.length === 0 ? (
        <EmptyState
          title="Nothing assigned yet"
          hint="Work items appear here once you are staffed on a project."
        />
      ) : (
        <ul className="space-y-4">
          {items.map((item) => {
            const open = ['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUESTED'].includes(item.status);
            const draft = drafts[item.id]!;
            return (
              <li key={item.id} className="rounded-lg border border-ink-200 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{item.reference}</span>
                  <StatusBadge status={item.status} />
                  <Badge tone="muted">{item.basis.toLowerCase()}</Badge>
                  <span className="text-xs text-ink-500">{item.projectLabel}</span>
                </div>
                <h3 className="mt-1 text-sm font-semibold text-ink-900">{item.title}</h3>
                {item.instructions && (
                  <p className="mt-1 whitespace-pre-line text-sm text-ink-600">
                    {item.instructions}
                  </p>
                )}

                {item.revisionRequest && (
                  <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    <span className="text-xs font-semibold">Changes requested</span>
                    <br />
                    <span className="whitespace-pre-line">{item.revisionRequest}</span>
                  </p>
                )}

                {item.reviewSummary && !item.revisionRequest && (
                  <p className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                    {item.reviewSummary}
                  </p>
                )}

                {open ? (
                  <div className="mt-3 space-y-2">
                    <div>
                      <label
                        htmlFor={`work-summary-${item.id}`}
                        className="text-xs font-semibold text-ink-700"
                      >
                        One-line summary
                      </label>
                      <input
                        id={`work-summary-${item.id}`}
                        className="input mt-1 w-full"
                        value={draft.summary}
                        onChange={(event) => patch(item.id, { summary: event.target.value })}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`work-content-${item.id}`}
                        className="text-xs font-semibold text-ink-700"
                      >
                        What you did
                      </label>
                      <textarea
                        id={`work-content-${item.id}`}
                        rows={4}
                        className="input mt-1 w-full"
                        value={draft.content}
                        onChange={(event) => patch(item.id, { content: event.target.value })}
                      />
                    </div>
                    {item.basis === 'HOURLY' && (
                      <div>
                        <label
                          htmlFor={`work-hours-${item.id}`}
                          className="text-xs font-semibold text-ink-700"
                        >
                          Hours worked
                        </label>
                        <input
                          id={`work-hours-${item.id}`}
                          className="input mt-1 w-32"
                          inputMode="decimal"
                          value={draft.hours}
                          onChange={(event) => patch(item.id, { hours: event.target.value })}
                        />
                      </div>
                    )}
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={pending !== null || !draft.content.trim()}
                      onClick={() => submit(item)}
                    >
                      {pending === item.id
                        ? 'Submitting…'
                        : item.status === 'REVISION_REQUESTED'
                          ? 'Submit revised work'
                          : 'Submit work'}
                    </button>
                  </div>
                ) : (
                  item.lastSubmission && (
                    <p className="mt-2 text-xs text-ink-500">
                      Revision {item.lastSubmission.revision} submitted. Nothing is needed from you
                      right now.
                    </p>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      )}
    </Card>
  );
}
