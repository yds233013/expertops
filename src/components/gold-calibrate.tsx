'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Alert, Badge } from '@/components/ui';

export interface CalibrationTask {
  id: string;
  reference: string;
  title: string;
  prompt: string;
  referenceAnswer: string;
  checkerText: string;
  domain: string | null;
}

interface AnswerResult {
  correct: boolean;
  expectedDecision: 'APPROVE' | 'REVISE';
  rationale: string;
}

const DECISION_LABEL = { APPROVE: 'Approve', REVISE: 'Request revision' } as const;

/**
 * HUMAN DECISION, write-once. The reviewer judges a task whose right answer is
 * already known, and only then sees the key and the reasoning behind it.
 */
export function GoldCalibrate({ task, remaining }: { task: CalibrationTask; remaining: number }) {
  const router = useRouter();
  const noteId = useId();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<'APPROVE' | 'REVISE' | null>(null);
  const [chosen, setChosen] = useState<'APPROVE' | 'REVISE' | null>(null);
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const left = result ? remaining - 1 : remaining;

  async function answer(decision: 'APPROVE' | 'REVISE') {
    setPending(decision);
    setError(null);
    const response = await apiPost<AnswerResult>(`/api/quality/gold-tasks/${task.id}`, {
      action: 'answer',
      decision,
      note: note.trim() || undefined,
    });
    setPending(null);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? 'Your answer could not be recorded.');
      return;
    }
    setChosen(decision);
    setResult(response.data);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-ink-500">{task.reference}</span>
        {task.domain && <Badge tone="muted">{task.domain}</Badge>}
        <span className="ml-auto text-xs text-ink-500">
          {left} unanswered {left === 1 ? 'task' : 'tasks'} for you
        </span>
      </div>
      <h3 className="text-sm font-semibold text-ink-900">{task.title}</h3>

      <div className="rounded-md border border-ink-200 bg-ink-50/60">
        <p className="border-b border-ink-200 px-3 py-1.5 text-xs font-semibold text-ink-600">
          Prompt
        </p>
        <p className="max-h-56 overflow-y-auto whitespace-pre-wrap px-3 py-2 text-sm text-ink-800 break-anywhere">
          {task.prompt}
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)]">
        <dt className="text-xs font-semibold text-ink-500 sm:pt-0.5">Reference answer</dt>
        <dd className="font-mono text-[0.8rem] text-ink-900 break-anywhere">
          {task.referenceAnswer}
        </dd>
        <dt className="text-xs font-semibold text-ink-500 sm:pt-0.5">Checker</dt>
        <dd className="text-ink-800 break-anywhere">{task.checkerText}</dd>
      </dl>

      {result ? (
        <div className="space-y-2" aria-live="polite">
          <Alert tone={result.correct ? 'success' : 'error'}>
            {result.correct ? 'Matches the key.' : 'Does not match the key.'} You chose{' '}
            <strong>{chosen ? DECISION_LABEL[chosen] : '—'}</strong>; the expected decision is{' '}
            <strong>{DECISION_LABEL[result.expectedDecision]}</strong>.
          </Alert>
          <div className="rounded-md border border-ink-200 px-3 py-2">
            <p className="text-xs font-semibold text-ink-600">Why</p>
            <p className="mt-0.5 whitespace-pre-line text-sm text-ink-800">{result.rationale}</p>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={advancing}
            onClick={() => {
              setAdvancing(true);
              router.refresh();
            }}
          >
            {advancing ? 'Loading…' : remaining > 1 ? 'Next gold task' : 'Done'}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div>
            <label className="label" htmlFor={noteId}>
              Note <span className="font-normal text-ink-500">(optional)</span>
            </label>
            <textarea
              id={noteId}
              className="textarea"
              rows={2}
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What you would tell the expert"
            />
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={pending !== null}
              onClick={() => answer('APPROVE')}
            >
              {pending === 'APPROVE' ? 'Recording…' : 'Approve'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={pending !== null}
              onClick={() => answer('REVISE')}
            >
              {pending === 'REVISE' ? 'Recording…' : 'Request revision'}
            </button>
            <span className="text-xs text-ink-500">One answer per task. It cannot be changed.</span>
          </div>
        </div>
      )}
    </div>
  );
}
