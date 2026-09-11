'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Card, EmptyState, StatusBadge } from '@/components/ui';
import { apiPatch, apiPost } from '@/lib/api-client';

interface ItemRow {
  id: string;
  key: string;
  label: string;
  helpText: string;
  kind: string;
  required: boolean;
  value: string | null;
  complete: boolean;
}

interface CaseRow {
  status: string;
  items: ItemRow[];
  decisionNote: string | null;
}

export function OnboardingPanel({ onboardingCase }: { onboardingCase: CaseRow | null }) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries((onboardingCase?.items ?? []).map((item) => [item.key, item.value ?? ''])),
  );
  const [pending, setPending] = useState<'save' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!onboardingCase) {
    return (
      <Card title="Onboarding">
        <EmptyState
          title="Nothing to complete yet"
          hint="Your checklist opens as soon as you accept a project invitation."
        />
      </Card>
    );
  }

  const readOnly = onboardingCase.status === 'SUBMITTED' || onboardingCase.status === 'VERIFIED';

  async function save(): Promise<boolean> {
    setPending('save');
    setError(null);
    setNotice(null);
    try {
      const result = await apiPatch('/api/portal/onboarding', {
        answers: Object.entries(answers).map(([key, value]) => ({ key, value })),
      });
      if (!result.ok) {
        setError(result.error?.message ?? 'Your answers could not be saved.');
        return false;
      }
      setNotice('Progress saved.');
      router.refresh();
      return true;
    } finally {
      setPending(null);
    }
  }

  async function submit() {
    const saved = await save();
    if (!saved) return;
    setPending('submit');
    setError(null);
    try {
      const result = await apiPost('/api/portal/onboarding/submit');
      if (!result.ok) {
        setError(result.error?.message ?? 'Your checklist could not be submitted.');
        return;
      }
      setNotice('Submitted. An ExpertOps operator will review it.');
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <Card
      title="Onboarding checklist"
      description="Complete every required item, then submit. An ExpertOps operator reviews the submission before you can be staffed."
      actions={<StatusBadge status={onboardingCase.status} />}
    >
      {onboardingCase.status === 'SUBMITTED' && (
        <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Submitted and waiting on a human operator. Nothing is approved automatically.
        </p>
      )}
      {onboardingCase.status === 'VERIFIED' && (
        <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          An operator verified your submission. You can now be assigned to a project seat.
        </p>
      )}
      {onboardingCase.status === 'REJECTED' && (
        <p className="mb-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
          An operator returned your submission.
          {onboardingCase.decisionNote ? ` Reason: ${onboardingCase.decisionNote}` : ''} Update the
          items below and submit again.
        </p>
      )}

      <div className="space-y-3">
        {onboardingCase.items.map((item) => (
          <div key={item.id} className="rounded-lg border border-ink-200 px-3 py-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-ink-900">
                  {item.label}
                  {!item.required && <span className="text-ink-400"> (optional)</span>}
                </p>
                <p className="text-xs text-ink-500">{item.helpText}</p>
              </div>
            </div>
            <div className="mt-2">
              {item.kind === 'ATTESTATION' ? (
                <label className="flex items-center gap-2 text-sm text-ink-800">
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={answers[item.key] === 'true'}
                    onChange={(event) =>
                      setAnswers((current) => ({
                        ...current,
                        [item.key]: event.target.checked ? 'true' : 'false',
                      }))
                    }
                  />
                  I confirm
                </label>
              ) : (
                <input
                  className="input"
                  disabled={readOnly}
                  maxLength={2000}
                  value={answers[item.key] ?? ''}
                  placeholder={item.kind === 'REFERENCE' ? 'SIM-BILL-0000' : 'Your answer'}
                  onChange={(event) =>
                    setAnswers((current) => ({ ...current, [item.key]: event.target.value }))
                  }
                />
              )}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{notice}</p>
      )}

      {!readOnly && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={pending !== null}
            onClick={save}
          >
            {pending === 'save' ? 'Saving…' : 'Save progress'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending !== null}
            onClick={submit}
          >
            {pending === 'submit' ? 'Submitting…' : 'Submit for review'}
          </button>
        </div>
      )}
    </Card>
  );
}
