'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { apiPost } from '@/lib/api-client';
import { Alert } from '@/components/ui';
import {
  CheckerFields,
  checkerFromDraft,
  EMPTY_CHECKER,
  type CheckerDraft,
} from './checker-fields';

const EMPTY = {
  title: '',
  domainId: '',
  prompt: '',
  referenceAnswer: '',
  expectedDecision: 'APPROVE' as 'APPROVE' | 'REVISE',
  rationale: '',
};

/** HUMAN ACTION. Add a task whose right review decision is known. */
export function GoldTaskForm({ domains }: { domains: { id: string; name: string }[] }) {
  const router = useRouter();
  const id = useId();
  const [draft, setDraft] = useState(EMPTY);
  const [checker, setChecker] = useState<CheckerDraft>(EMPTY_CHECKER);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  function patch(change: Partial<typeof EMPTY>) {
    setDraft((current) => ({ ...current, ...change }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(null);
    const built = checkerFromDraft(checker);
    if ('error' in built) {
      setError(built.error);
      return;
    }
    setPending(true);
    const response = await apiPost<{ goldTask: { reference: string } }>('/api/quality/gold-tasks', {
      title: draft.title,
      domainId: draft.domainId || null,
      prompt: draft.prompt,
      referenceAnswer: draft.referenceAnswer,
      checker: built.checker,
      expectedDecision: draft.expectedDecision,
      rationale: draft.rationale,
    });
    setPending(false);
    if (!response.ok) {
      setError(response.error?.message ?? 'The gold task could not be saved.');
      return;
    }
    setSaved(response.data?.goldTask.reference ?? 'The gold task');
    setDraft(EMPTY);
    setChecker(EMPTY_CHECKER);
    router.refresh();
  }

  const ready =
    draft.title.trim().length >= 3 &&
    draft.prompt.trim().length > 0 &&
    draft.referenceAnswer.trim().length > 0 &&
    draft.rationale.trim().length >= 10;

  return (
    <form className="space-y-3" onSubmit={submit} noValidate>
      <div className="grid grid-cols-1 gap-3">
        <div>
          <label className="label" htmlFor={`${id}-title`}>
            Title
          </label>
          <input
            id={`${id}-title`}
            className="input"
            value={draft.title}
            maxLength={200}
            onChange={(event) => patch({ title: event.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-domain`}>
            Domain <span className="font-normal text-ink-500">(optional)</span>
          </label>
          <select
            id={`${id}-domain`}
            className="select"
            value={draft.domainId}
            onChange={(event) => patch({ domainId: event.target.value })}
          >
            <option value="">Any domain</option>
            {domains.map((domain) => (
              <option key={domain.id} value={domain.id}>
                {domain.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="label" htmlFor={`${id}-prompt`}>
          Prompt
        </label>
        <textarea
          id={`${id}-prompt`}
          className="textarea"
          rows={4}
          value={draft.prompt}
          onChange={(event) => patch({ prompt: event.target.value })}
        />
      </div>

      <div>
        <label className="label" htmlFor={`${id}-reference`}>
          Reference answer
        </label>
        <input
          id={`${id}-reference`}
          className="input font-mono"
          value={draft.referenceAnswer}
          onChange={(event) => patch({ referenceAnswer: event.target.value })}
        />
      </div>

      <CheckerFields idPrefix={id} value={checker} onChange={setChecker} />

      <fieldset>
        <legend className="label">Expected review decision</legend>
        <div className="segmented" role="radiogroup">
          {(['APPROVE', 'REVISE'] as const).map((decision) => (
            <label
              key={decision}
              className="segmented-item cursor-pointer has-[:checked]:bg-white has-[:checked]:text-accent-700 has-[:checked]:shadow-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent-300"
            >
              <input
                type="radio"
                className="sr-only"
                name={`${id}-decision`}
                value={decision}
                checked={draft.expectedDecision === decision}
                onChange={() => patch({ expectedDecision: decision })}
              />
              {decision === 'APPROVE' ? 'Approve' : 'Request revision'}
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label className="label" htmlFor={`${id}-rationale`}>
          Why that is the right decision
        </label>
        <textarea
          id={`${id}-rationale`}
          className="textarea"
          rows={3}
          value={draft.rationale}
          onChange={(event) => patch({ rationale: event.target.value })}
          aria-describedby={`${id}-rationale-hint`}
        />
        <p id={`${id}-rationale-hint`} className="mt-1 text-xs text-ink-500">
          Shown to a reviewer only after they answer, so they learn from a miss straight away.
        </p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {saved && (
        <Alert tone="success">
          {saved} added. It goes to every reviewer who has not answered it.
        </Alert>
      )}

      <button type="submit" className="btn btn-primary btn-sm" disabled={pending || !ready}>
        {pending ? 'Saving…' : 'Add gold task'}
      </button>
    </form>
  );
}
