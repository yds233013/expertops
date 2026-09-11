'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Badge } from '@/components/ui';

export interface OperatorReply {
  id: string;
  authorType: string;
  authorName: string;
  body: string;
  internalOnly: boolean;
  createdAt: string;
}

/**
 * The operator's side of a support conversation.
 *
 * The internal-note checkbox is the only control that changes who can read a
 * reply, and it is labelled with that consequence rather than with a jargon
 * flag name. Internal notes are drawn distinctly so nobody mistakes one for
 * something the expert has seen.
 */
export function SupportThread({
  requestId,
  reference,
  status,
  replies,
  owners,
  ownerId,
  canRespond,
}: {
  requestId: string;
  reference: string;
  status: string;
  replies: OperatorReply[];
  owners: { id: string; name: string }[];
  ownerId: string | null;
  canRespond: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [internalOnly, setInternalOnly] = useState(false);
  const [resolution, setResolution] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(payload: Record<string, unknown>, label: string) {
    setPending(label);
    setError(null);
    try {
      const result = await apiPost(`/api/support-requests/${requestId}`, payload);
      if (!result.ok) {
        setError(result.error?.message ?? 'That could not be saved.');
        return false;
      }
      router.refresh();
      return true;
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {replies.map((reply) => (
          <li
            key={reply.id}
            className={
              reply.internalOnly
                ? 'rounded-md border border-dashed border-ink-300 bg-ink-50 px-3 py-2 text-sm'
                : reply.authorType === 'OPERATOR'
                  ? 'rounded-md bg-accent-50 px-3 py-2 text-sm text-ink-800'
                  : 'rounded-md bg-white px-3 py-2 text-sm text-ink-800 ring-1 ring-ink-200'
            }
          >
            <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-ink-500">
              {reply.authorName}
              {reply.internalOnly && <Badge tone="muted">internal, not sent to the expert</Badge>}
            </p>
            <p className="mt-0.5 whitespace-pre-line">{reply.body}</p>
          </li>
        ))}
      </ol>

      {canRespond && status !== 'CLOSED' && (
        <div className="space-y-2 rounded-lg border border-ink-200 px-3 py-3">
          <label htmlFor={`reply-${requestId}`} className="text-xs font-semibold text-ink-700">
            Reply to {reference}
          </label>
          <textarea
            id={`reply-${requestId}`}
            rows={3}
            className="input w-full"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <label className="flex items-center gap-2 text-xs text-ink-700">
            <input
              type="checkbox"
              checked={internalOnly}
              onChange={(event) => setInternalOnly(event.target.checked)}
            />
            Internal note: keep this out of the expert&rsquo;s portal
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={pending !== null || !body.trim()}
              onClick={async () => {
                const sent = await send(
                  { action: 'reply', body: body.trim(), internalOnly },
                  'reply',
                );
                if (sent) {
                  setBody('');
                  setInternalOnly(false);
                }
              }}
            >
              {pending === 'reply'
                ? 'Sending…'
                : internalOnly
                  ? 'Save internal note'
                  : 'Send reply'}
            </button>

            <label className="sr-only" htmlFor={`owner-${requestId}`}>
              Owner for {reference}
            </label>
            <select
              id={`owner-${requestId}`}
              className="input"
              value={ownerId ?? ''}
              disabled={pending !== null}
              onChange={(event) =>
                send({ action: 'assign', ownerId: event.target.value || null }, 'assign')
              }
            >
              <option value="">Unassigned</option>
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.name}
                </option>
              ))}
            </select>
          </div>

          <div className="border-t border-ink-100 pt-2">
            <label
              htmlFor={`resolution-${requestId}`}
              className="text-xs font-semibold text-ink-700"
            >
              Resolution
            </label>
            <textarea
              id={`resolution-${requestId}`}
              rows={2}
              className="input mt-1 w-full"
              placeholder="What was done. Required to resolve."
              value={resolution}
              onChange={(event) => setResolution(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm mt-2"
              disabled={pending !== null || !resolution.trim()}
              onClick={async () => {
                const done = await send(
                  { action: 'resolve', resolution: resolution.trim() },
                  'resolve',
                );
                if (done) setResolution('');
              }}
            >
              {pending === 'resolve' ? 'Saving…' : 'Mark resolved'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}
