'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Badge, Card, EmptyState, StatusBadge } from '@/components/ui';

export interface PortalReply {
  id: string;
  authorType: string;
  body: string;
  createdAt: string;
}

export interface PortalThread {
  id: string;
  reference: string;
  subject: string;
  message: string;
  category: string;
  status: string;
  createdAt: string;
  project: { code: string; title: string } | null;
  replies: PortalReply[];
}

const CATEGORIES = [
  ['ACCESS', 'Access or sign-in'],
  ['SCOPE_QUESTION', 'Question about scope'],
  ['TOOLING', 'Tooling problem'],
  ['SCHEDULING', 'Scheduling'],
  ['PAYMENT', 'Payment'],
  ['OTHER', 'Something else'],
] as const;

/**
 * The expert's side of a support conversation.
 *
 * Only replies the server considered expert-visible ever reach this component:
 * internal operator notes are filtered out in `listSupportForExpert`, not here.
 */
export function SupportPanel({
  threads,
  projects,
}: {
  threads: PortalThread[];
  projects: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [category, setCategory] = useState<string>('OTHER');
  const [projectId, setProjectId] = useState<string>('');
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function raise(event: React.FormEvent) {
    event.preventDefault();
    setPending('new');
    setError(null);
    try {
      const result = await apiPost('/api/portal/support', {
        subject,
        message,
        category,
        projectId: projectId || null,
      });
      if (!result.ok) {
        setError(result.error?.message ?? 'Your request could not be sent.');
        return;
      }
      setSubject('');
      setMessage('');
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function reply(threadId: string) {
    const body = (replies[threadId] ?? '').trim();
    if (!body) return;
    setPending(threadId);
    setError(null);
    try {
      const result = await apiPost(`/api/portal/support/${threadId}`, { body });
      if (!result.ok) {
        setError(result.error?.message ?? 'Your reply could not be sent.');
        return;
      }
      setReplies((previous) => ({ ...previous, [threadId]: '' }));
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <Card
      title="Support"
      description="Ask the operations team about access, scope, tooling, scheduling or payment."
    >
      <div className="space-y-5">
        {threads.length === 0 ? (
          <EmptyState title="No support requests" hint="Anything you raise appears here." />
        ) : (
          <ul className="space-y-4">
            {threads.map((thread) => (
              <li key={thread.id} className="rounded-lg border border-ink-200 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{thread.reference}</span>
                  <StatusBadge status={thread.status} />
                  <Badge tone="muted">{thread.category.replace(/_/g, ' ').toLowerCase()}</Badge>
                  {thread.project && (
                    <span className="text-xs text-ink-500">
                      {thread.project.code} · {thread.project.title}
                    </span>
                  )}
                </div>
                <h3 className="mt-1 text-sm font-semibold text-ink-900">{thread.subject}</h3>

                <ol className="mt-2 space-y-2">
                  <li className="rounded-md bg-ink-50 px-3 py-2 text-sm text-ink-800">
                    <p className="text-xs font-semibold text-ink-500">You wrote</p>
                    <p className="mt-0.5 whitespace-pre-line">{thread.message}</p>
                  </li>
                  {thread.replies.map((entry) => (
                    <li
                      key={entry.id}
                      className={
                        entry.authorType === 'OPERATOR'
                          ? 'rounded-md bg-accent-50 px-3 py-2 text-sm text-ink-800'
                          : 'rounded-md bg-ink-50 px-3 py-2 text-sm text-ink-800'
                      }
                    >
                      <p className="text-xs font-semibold text-ink-500">
                        {entry.authorType === 'OPERATOR' ? 'ExpertOps' : 'You'}
                      </p>
                      <p className="mt-0.5 whitespace-pre-line">{entry.body}</p>
                    </li>
                  ))}
                </ol>

                {thread.status !== 'CLOSED' && (
                  <div className="mt-2">
                    <label htmlFor={`reply-${thread.id}`} className="sr-only">
                      Reply to {thread.reference}
                    </label>
                    <textarea
                      id={`reply-${thread.id}`}
                      rows={2}
                      className="input w-full"
                      placeholder="Write a reply"
                      value={replies[thread.id] ?? ''}
                      onChange={(event) =>
                        setReplies((previous) => ({ ...previous, [thread.id]: event.target.value }))
                      }
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm mt-2"
                      disabled={pending !== null || !(replies[thread.id] ?? '').trim()}
                      onClick={() => reply(thread.id)}
                    >
                      {pending === thread.id ? 'Sending…' : 'Send reply'}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <form className="space-y-3 border-t border-ink-100 pt-4" onSubmit={raise}>
          <h3 className="text-sm font-semibold text-ink-900">Raise a new request</h3>

          <div>
            <label htmlFor="support-subject" className="text-xs font-semibold text-ink-700">
              Subject
            </label>
            <input
              id="support-subject"
              className="input mt-1 w-full"
              required
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="support-category" className="text-xs font-semibold text-ink-700">
                Category
              </label>
              <select
                id="support-category"
                className="input mt-1 w-full"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                {CATEGORIES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="support-project" className="text-xs font-semibold text-ink-700">
                Project (optional)
              </label>
              <select
                id="support-project"
                className="input mt-1 w-full"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">Not about a project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="support-message" className="text-xs font-semibold text-ink-700">
              What do you need?
            </label>
            <textarea
              id="support-message"
              rows={4}
              className="input mt-1 w-full"
              required
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          </div>

          {error && (
            <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {error}
            </p>
          )}

          <button type="submit" className="btn btn-primary" disabled={pending === 'new'}>
            {pending === 'new' ? 'Sending…' : 'Send request'}
          </button>
        </form>
      </div>
    </Card>
  );
}
