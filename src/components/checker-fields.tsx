'use client';

import type { TaskChecker } from '@/server/domain/task-checks';

/**
 * The checker part of a task form: how an answer is judged right.
 *
 * Shared by the expert's task form and the operators' gold-task form, so a
 * checker is described in the same words wherever someone writes one.
 */
export interface CheckerDraft {
  kind: TaskChecker['kind'];
  caseSensitive: boolean;
  tolerance: string;
  pattern: string;
}

export const EMPTY_CHECKER: CheckerDraft = {
  kind: 'EXACT',
  caseSensitive: false,
  tolerance: '0',
  pattern: '',
};

export function draftFromChecker(checker: TaskChecker | null | undefined): CheckerDraft {
  if (!checker) return EMPTY_CHECKER;
  switch (checker.kind) {
    case 'EXACT':
      return { ...EMPTY_CHECKER, kind: 'EXACT', caseSensitive: checker.caseSensitive };
    case 'NUMERIC':
      return { ...EMPTY_CHECKER, kind: 'NUMERIC', tolerance: String(checker.tolerance) };
    case 'REGEX':
      return { ...EMPTY_CHECKER, kind: 'REGEX', pattern: checker.pattern };
  }
}

export function checkerFromDraft(
  draft: CheckerDraft,
): { checker: TaskChecker } | { error: string } {
  switch (draft.kind) {
    case 'EXACT':
      return { checker: { kind: 'EXACT', caseSensitive: draft.caseSensitive } };
    case 'NUMERIC': {
      const raw = draft.tolerance.trim();
      const tolerance = raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(tolerance) || tolerance < 0) {
        return { error: 'The allowed difference must be zero or a positive number.' };
      }
      return { checker: { kind: 'NUMERIC', tolerance } };
    }
    case 'REGEX': {
      const pattern = draft.pattern.trim();
      if (!pattern) return { error: 'Write the pattern a right answer must match.' };
      try {
        new RegExp(pattern, 'iu');
      } catch {
        return { error: 'That pattern is not a valid regular expression.' };
      }
      return { checker: { kind: 'REGEX', pattern } };
    }
  }
}

const KIND_HELP: Record<TaskChecker['kind'], string> = {
  EXACT:
    'The answer must match your reference word for word. Spacing and a final full stop are ignored.',
  NUMERIC:
    'The answer must be a single number. Commas, a currency sign or a percent sign are fine.',
  REGEX:
    'For answers that can be written more than one way. The whole answer must match the pattern; capital letters are ignored.',
};

export function CheckerFields({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: CheckerDraft;
  onChange: (next: CheckerDraft) => void;
}) {
  const patch = (change: Partial<CheckerDraft>) => onChange({ ...value, ...change });
  const helpId = `${idPrefix}-checker-help`;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[17rem_minmax(0,1fr)]">
      <div>
        <label className="label" htmlFor={`${idPrefix}-checker-kind`}>
          How is an answer marked right?
        </label>
        <select
          id={`${idPrefix}-checker-kind`}
          className="select"
          value={value.kind}
          aria-describedby={helpId}
          onChange={(event) => patch({ kind: event.target.value as CheckerDraft['kind'] })}
        >
          <option value="EXACT">Same text as the reference</option>
          <option value="NUMERIC">Same number, within a margin</option>
          <option value="REGEX">Matches a pattern</option>
        </select>
      </div>

      <div className="min-w-0">
        {value.kind === 'EXACT' && (
          <div className="sm:pt-6">
            <label className="inline-flex items-center gap-2 text-sm text-ink-800">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-ink-300 accent-accent-500"
                checked={value.caseSensitive}
                onChange={(event) => patch({ caseSensitive: event.target.checked })}
                aria-describedby={helpId}
              />
              Capital letters matter
            </label>
          </div>
        )}
        {value.kind === 'NUMERIC' && (
          <div>
            <label className="label" htmlFor={`${idPrefix}-tolerance`}>
              Allowed difference
            </label>
            <input
              id={`${idPrefix}-tolerance`}
              className="input w-40"
              inputMode="decimal"
              value={value.tolerance}
              onChange={(event) => patch({ tolerance: event.target.value })}
              aria-describedby={helpId}
            />
          </div>
        )}
        {value.kind === 'REGEX' && (
          <div>
            <label className="label" htmlFor={`${idPrefix}-pattern`}>
              Pattern
            </label>
            <input
              id={`${idPrefix}-pattern`}
              className="input font-mono"
              value={value.pattern}
              maxLength={300}
              placeholder="e.g. (12|twelve) ?(m|metres)"
              onChange={(event) => patch({ pattern: event.target.value })}
              aria-describedby={helpId}
            />
          </div>
        )}
      </div>
      <p id={helpId} className="text-xs text-ink-500 sm:col-span-2">
        {KIND_HELP[value.kind]}
        {value.kind === 'NUMERIC' && ' Use 0 if the number must be exact.'}
      </p>
    </div>
  );
}
