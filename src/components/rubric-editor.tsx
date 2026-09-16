'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';
import { Badge } from '@/components/ui';

export interface CriterionDraft {
  key: string;
  label: string;
  scoringGuidance: string;
  maxScore: number;
  weight: number;
  requiredEvidence: string;
  isGating: boolean;
}

const EVIDENCE_OPTIONS = [
  ['NONE', 'No specific evidence'],
  ['WRITTEN_ANSWER', 'Written answer'],
  ['WORK_SAMPLE_LINK', 'Work sample link'],
  ['REFERENCE_STATEMENT', 'Reference statement'],
] as const;

export function emptyCriterion(): CriterionDraft {
  return {
    key: '',
    label: '',
    scoringGuidance: '',
    maxScore: 5,
    weight: 1,
    requiredEvidence: 'NONE',
    isGating: false,
  };
}

/**
 * Edit and publish a draft rubric version.
 *
 * Validation lives in the service, not here: this form submits what the
 * operator typed and renders the refusal it gets back, so the rule about
 * duplicate keys or out-of-range scores has exactly one definition.
 *
 * Publishing is separated from saving and carries its own confirmation, because
 * a published version can never be edited again.
 */
export function RubricEditor({
  versionId,
  versionNumber,
  templateName,
  initialCriteria,
  initialPassThreshold,
  initialGuidance,
  initialChangeNote,
  canPublish,
}: {
  versionId: string;
  versionNumber: number;
  templateName: string;
  initialCriteria: CriterionDraft[];
  initialPassThreshold: number;
  initialGuidance: string;
  initialChangeNote: string;
  canPublish: boolean;
}) {
  const router = useRouter();
  const [criteria, setCriteria] = useState<CriterionDraft[]>(
    initialCriteria.length > 0 ? initialCriteria : [emptyCriterion()],
  );
  const [passThreshold, setPassThreshold] = useState(initialPassThreshold);
  const [guidance, setGuidance] = useState(initialGuidance);
  const [changeNote, setChangeNote] = useState(initialChangeNote);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingPublish, setConfirmingPublish] = useState(false);

  const maxPossible = criteria.reduce(
    (total, criterion) => total + criterion.maxScore * criterion.weight,
    0,
  );

  function update(index: number, patch: Partial<CriterionDraft>) {
    setCriteria((previous) =>
      previous.map((criterion, position) =>
        position === index ? { ...criterion, ...patch } : criterion,
      ),
    );
  }

  async function save(): Promise<boolean> {
    setPending('save');
    setError(null);
    setNotice(null);
    try {
      const result = await apiPost('/api/rubrics', {
        action: 'update_draft',
        versionId,
        criteria: criteria.map((criterion) => ({
          key: criterion.key || criterion.label,
          label: criterion.label,
          scoringGuidance: criterion.scoringGuidance,
          maxScore: criterion.maxScore,
          weight: criterion.weight,
          requiredEvidence: criterion.requiredEvidence,
          isGating: criterion.isGating,
        })),
        passThreshold,
        guidance,
        changeNote,
      });
      if (!result.ok) {
        setError(result.error?.message ?? 'The draft could not be saved.');
        return false;
      }
      setNotice('Draft saved.');
      router.refresh();
      return true;
    } finally {
      setPending(null);
    }
  }

  async function publish() {
    if (!(await save())) return;
    setPending('publish');
    setError(null);
    try {
      const result = await apiPost('/api/rubrics', { action: 'publish', versionId });
      if (!result.ok) {
        setError(result.error?.message ?? 'This version could not be published.');
        return;
      }
      setConfirmingPublish(false);
      setNotice(`Version ${versionNumber} published. It can no longer be edited.`);
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label
            htmlFor={`threshold-${versionId}`}
            className="text-xs font-semibold uppercase tracking-wide text-ink-500"
          >
            Pass threshold
          </label>
          <input
            id={`threshold-${versionId}`}
            type="number"
            min={0}
            max={200}
            className="input"
            value={passThreshold}
            aria-describedby={`threshold-help-${versionId}`}
            onChange={(event) => setPassThreshold(Number(event.target.value))}
          />
          <p id={`threshold-help-${versionId}`} className="mt-1 text-xs text-ink-500">
            Advisory only. Maximum weighted score with these criteria is {maxPossible}.
          </p>
        </div>
        <div>
          <label
            htmlFor={`change-note-${versionId}`}
            className="text-xs font-semibold uppercase tracking-wide text-ink-500"
          >
            Why this version exists
          </label>
          <input
            id={`change-note-${versionId}`}
            className="input"
            value={changeNote}
            onChange={(event) => setChangeNote(event.target.value)}
          />
        </div>
      </div>

      <div>
        <label
          htmlFor={`guidance-${versionId}`}
          className="text-xs font-semibold uppercase tracking-wide text-ink-500"
        >
          Instructions shown to the candidate
        </label>
        <textarea
          id={`guidance-${versionId}`}
          rows={3}
          className="input"
          value={guidance}
          onChange={(event) => setGuidance(event.target.value)}
        />
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Criteria</h4>
        {criteria.map((criterion, index) => (
          <fieldset key={index} className="rounded-lg border border-ink-200 px-3 py-3">
            <legend className="px-1 text-xs font-semibold text-ink-600">
              Criterion {index + 1}
            </legend>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor={`label-${versionId}-${index}`} className="label">
                  Label
                </label>
                <input
                  id={`label-${versionId}-${index}`}
                  className="input"
                  value={criterion.label}
                  onChange={(event) => update(index, { label: event.target.value })}
                />
              </div>
              <div>
                <label htmlFor={`key-${versionId}-${index}`} className="label">
                  Key
                </label>
                <input
                  id={`key-${versionId}-${index}`}
                  className="input mt-1 w-full font-mono text-xs"
                  placeholder="derived from the label if left blank"
                  value={criterion.key}
                  onChange={(event) => update(index, { key: event.target.value })}
                />
              </div>
            </div>

            <div className="mt-3">
              <label htmlFor={`scoring-${versionId}-${index}`} className="label">
                What a reviewer should look for
              </label>
              <textarea
                id={`scoring-${versionId}-${index}`}
                rows={2}
                className="input"
                value={criterion.scoringGuidance}
                onChange={(event) => update(index, { scoringGuidance: event.target.value })}
              />
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor={`max-${versionId}-${index}`} className="label">
                  Max score
                </label>
                <input
                  id={`max-${versionId}-${index}`}
                  type="number"
                  min={1}
                  max={10}
                  className="input"
                  value={criterion.maxScore}
                  onChange={(event) => update(index, { maxScore: Number(event.target.value) })}
                />
              </div>
              <div>
                <label htmlFor={`weight-${versionId}-${index}`} className="label">
                  Weight
                </label>
                <input
                  id={`weight-${versionId}-${index}`}
                  type="number"
                  min={1}
                  max={10}
                  className="input"
                  value={criterion.weight}
                  onChange={(event) => update(index, { weight: Number(event.target.value) })}
                />
              </div>
              <div>
                <label htmlFor={`evidence-${versionId}-${index}`} className="label">
                  Required evidence
                </label>
                <select
                  id={`evidence-${versionId}-${index}`}
                  className="select"
                  value={criterion.requiredEvidence}
                  onChange={(event) => update(index, { requiredEvidence: event.target.value })}
                >
                  {EVIDENCE_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs text-ink-700">
                <input
                  type="checkbox"
                  checked={criterion.isGating}
                  onChange={(event) => update(index, { isGating: event.target.checked })}
                />
                Gating: failing this fails the screening regardless of total score
              </label>
              {criteria.length > 1 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() =>
                    setCriteria((previous) => previous.filter((_, position) => position !== index))
                  }
                >
                  Remove
                </button>
              )}
            </div>
          </fieldset>
        ))}

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setCriteria((previous) => [...previous, emptyCriterion()])}
        >
          Add criterion
        </button>
      </div>

      {error && (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="alert alert-success">
          {notice}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={pending !== null}
          onClick={() => save()}
        >
          {pending === 'save' ? 'Saving…' : 'Save draft'}
        </button>

        {canPublish ? (
          confirmingPublish ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={pending !== null}
                onClick={publish}
              >
                {pending === 'publish' ? 'Publishing…' : `Confirm: publish v${versionNumber}`}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmingPublish(false)}
              >
                Cancel
              </button>
              <span className="text-xs text-ink-600">
                Published versions are permanent. Screenings already running keep the version they
                started on.
              </span>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending !== null}
              onClick={() => setConfirmingPublish(true)}
            >
              Publish v{versionNumber}
            </button>
          )
        ) : (
          <Badge tone="muted">Publishing is reserved for an admin</Badge>
        )}
        <span className="text-xs text-ink-500">{templateName}</span>
      </div>
    </div>
  );
}
