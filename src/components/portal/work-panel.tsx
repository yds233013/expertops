'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { formatDate } from '@/lib/time';
import type { TaskSpec } from '@/server/domain/task-checks';
import { Badge, Card, EmptyState, StatusBadge } from '@/components/ui';
import { TaskSpecView } from '@/components/task-quality';
import {
  CheckerFields,
  checkerFromDraft,
  draftFromChecker,
  type CheckerDraft,
} from '@/components/checker-fields';

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
    submittedAt: string;
    taskSpec: TaskSpec | null;
  } | null;
  /** Every revision the expert has handed in, newest first. */
  history: {
    revision: number;
    summary: string;
    submittedAt: string;
    taskSpec: TaskSpec | null;
  }[];
  revisionRequest: string | null;
  reviewSummary: string | null;
}

/**
 * The expert's delivery panel.
 *
 * A revision request is shown as the first thing on the item, because it is the
 * only reason the expert is looking at an item they already submitted.
 */
interface Draft {
  content: string;
  summary: string;
  hours: string;
  /** Whether this submission is an evaluation task with a checkable answer. */
  isTask: boolean;
  prompt: string;
  referenceAnswer: string;
  checker: CheckerDraft;
}

function initialDraft(item: PortalWorkItem): Draft {
  const spec = item.lastSubmission?.taskSpec ?? null;
  return {
    content: item.lastSubmission?.content ?? '',
    summary: item.lastSubmission?.summary ?? '',
    hours: item.lastSubmission?.hoursClaimed ?? '',
    isTask: spec !== null,
    prompt: spec?.prompt ?? '',
    referenceAnswer: spec?.referenceAnswer ?? '',
    checker: draftFromChecker(spec?.checker),
  };
}

export function WorkPanel({ items }: { items: PortalWorkItem[] }) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(items.map((item) => [item.id, initialDraft(item)])),
  );
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);

  function patch(id: string, change: Partial<Draft>) {
    setDrafts((previous) => ({ ...previous, [id]: { ...previous[id]!, ...change } }));
  }

  async function submit(item: PortalWorkItem) {
    const draft = drafts[item.id]!;
    setError(null);

    let taskSpec: TaskSpec | undefined;
    if (draft.isTask) {
      const built = checkerFromDraft(draft.checker);
      if ('error' in built) {
        setError({ id: item.id, message: built.error });
        return;
      }
      taskSpec = {
        prompt: draft.prompt.trim(),
        referenceAnswer: draft.referenceAnswer.trim(),
        checker: built.checker,
      };
    }

    setPending(item.id);
    try {
      const result = await apiPost(`/api/portal/work/${item.id}`, {
        content: draft.content,
        summary: draft.summary || undefined,
        hoursClaimed: item.basis === 'HOURLY' ? draft.hours : undefined,
        ...(taskSpec ? { taskSpec } : {}),
      });
      if (!result.ok) {
        setError({
          id: item.id,
          message: result.error?.message ?? 'Your work could not be submitted.',
        });
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
                      <label htmlFor={`work-summary-${item.id}`} className="label">
                        One-line summary
                      </label>
                      <input
                        id={`work-summary-${item.id}`}
                        className="input"
                        value={draft.summary}
                        onChange={(event) => patch(item.id, { summary: event.target.value })}
                      />
                    </div>
                    <div>
                      <label htmlFor={`work-content-${item.id}`} className="label">
                        What you did
                      </label>
                      <textarea
                        id={`work-content-${item.id}`}
                        rows={4}
                        className="input"
                        value={draft.content}
                        onChange={(event) => patch(item.id, { content: event.target.value })}
                      />
                    </div>
                    {item.basis === 'HOURLY' && (
                      <div>
                        <label htmlFor={`work-hours-${item.id}`} className="label">
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

                    <div className="rounded-md border border-ink-200 bg-ink-50/60 px-3 py-2.5">
                      <label className="flex cursor-pointer items-start gap-2.5">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 shrink-0 rounded border-ink-300 accent-accent-500"
                          checked={draft.isTask}
                          aria-controls={`work-task-${item.id}`}
                          onChange={(event) => patch(item.id, { isTask: event.target.checked })}
                        />
                        <span>
                          <span className="block text-sm font-semibold text-ink-900">
                            This is an evaluation task
                          </span>
                          <span className="block text-xs text-ink-500">
                            Tick this if you wrote a question with one right answer. We try it
                            against an AI model to check it can be graded, does not give its answer
                            away, and is not too easy.
                          </span>
                        </span>
                      </label>

                      {draft.isTask && (
                        <fieldset
                          id={`work-task-${item.id}`}
                          className="mt-3 space-y-3 border-t border-ink-200 pt-3"
                        >
                          <legend className="sr-only">Evaluation task</legend>
                          <div>
                            <label htmlFor={`work-prompt-${item.id}`} className="label">
                              The task, as the model will see it
                            </label>
                            <textarea
                              id={`work-prompt-${item.id}`}
                              rows={5}
                              className="textarea"
                              value={draft.prompt}
                              aria-describedby={`work-prompt-hint-${item.id}`}
                              onChange={(event) => patch(item.id, { prompt: event.target.value })}
                            />
                            <p
                              id={`work-prompt-hint-${item.id}`}
                              className="mt-1 text-xs text-ink-500"
                            >
                              Include everything needed to solve it. Do not include the answer.
                            </p>
                          </div>
                          <div>
                            <label htmlFor={`work-reference-${item.id}`} className="label">
                              The right answer
                            </label>
                            <input
                              id={`work-reference-${item.id}`}
                              className="input font-mono"
                              value={draft.referenceAnswer}
                              onChange={(event) =>
                                patch(item.id, { referenceAnswer: event.target.value })
                              }
                            />
                          </div>
                          <CheckerFields
                            idPrefix={`work-${item.id}`}
                            value={draft.checker}
                            onChange={(checker) => patch(item.id, { checker })}
                          />
                        </fieldset>
                      )}
                    </div>

                    {error?.id === item.id && (
                      <p
                        role="alert"
                        className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800"
                      >
                        {error.message}
                      </p>
                    )}

                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={
                        pending !== null ||
                        !draft.content.trim() ||
                        (draft.isTask && (!draft.prompt.trim() || !draft.referenceAnswer.trim()))
                      }
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

                {item.history.length > 0 && (
                  <details className="group mt-3 border-t border-ink-100 pt-2">
                    <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded text-xs font-semibold text-ink-700">
                      <span
                        aria-hidden="true"
                        className="text-ink-400 transition-transform group-open:rotate-90"
                      >
                        &rsaquo;
                      </span>
                      Your submissions ({item.history.length})
                    </summary>
                    <ol className="mt-2 space-y-2">
                      {item.history.map((entry) => (
                        <li
                          key={entry.revision}
                          className="rounded-md border border-ink-200 px-3 py-2"
                        >
                          <p className="flex flex-wrap items-center gap-2 text-xs text-ink-600">
                            <span className="font-semibold text-ink-800">
                              Revision {entry.revision}
                            </span>
                            <span>{formatDate(entry.submittedAt)}</span>
                            {entry.taskSpec && <Badge tone="info">evaluation task</Badge>}
                          </p>
                          {entry.summary && (
                            <p className="mt-1 text-sm text-ink-700">{entry.summary}</p>
                          )}
                          {entry.taskSpec && (
                            <div className="mt-2">
                              <TaskSpecView spec={entry.taskSpec} />
                            </div>
                          )}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
