import {
  checkerSchema,
  VERDICT_GUIDANCE,
  VERDICTS_NEEDING_ATTENTION,
  type TaskChecker,
  type TaskVerdict,
} from '@/server/domain/task-checks';

/**
 * Display helpers for task checks. Pure, so the operator pages and the
 * expert's portal word a checker the same way.
 */

export const VERDICT_ORDER: TaskVerdict[] = [
  'BROKEN_SPEC',
  'ANSWER_LEAK',
  'TOO_EASY',
  'DISCRIMINATING',
  'UNSOLVED',
];

export const VERDICT_LABEL: Record<TaskVerdict, string> = {
  BROKEN_SPEC: 'Broken spec',
  ANSWER_LEAK: 'Answer leak',
  TOO_EASY: 'Too easy',
  DISCRIMINATING: 'Discriminating',
  UNSOLVED: 'Unsolved',
};

/** Rose for a task that cannot measure anything, amber for one a person should look at. */
export const VERDICT_TONE: Record<TaskVerdict, 'danger' | 'warning' | 'success' | 'neutral'> = {
  BROKEN_SPEC: 'danger',
  ANSWER_LEAK: 'danger',
  TOO_EASY: 'warning',
  DISCRIMINATING: 'success',
  UNSOLVED: 'neutral',
};

export { VERDICT_GUIDANCE, VERDICTS_NEEDING_ATTENTION };

export function isTaskVerdict(value: unknown): value is TaskVerdict {
  return typeof value === 'string' && (VERDICT_ORDER as string[]).includes(value);
}

export function needsAttention(verdict: TaskVerdict | null | undefined): boolean {
  return verdict ? VERDICTS_NEEDING_ATTENTION.includes(verdict) : false;
}

/** Parse a stored checker. Null when the JSON is not one. */
export function parseChecker(value: unknown): TaskChecker | null {
  const parsed = checkerSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The checker in words: "Numeric, ±0.01", "Exact text, case-insensitive". */
export function describeChecker(checker: TaskChecker | null): string {
  if (!checker) return 'Unrecognised checker';
  switch (checker.kind) {
    case 'EXACT':
      return `Exact text, ${checker.caseSensitive ? 'case-sensitive' : 'case-insensitive'}`;
    case 'NUMERIC':
      return checker.tolerance === 0
        ? 'Numeric, exact value'
        : `Numeric, ±${checker.tolerance.toLocaleString('en-US', { maximumFractionDigits: 12 })}`;
    case 'REGEX':
      return `Pattern match: ${checker.pattern}`;
  }
}

/** An estimate in micro-dollars, shown to four decimals when it is under a cent. */
export function formatCostMicros(micros: number): string {
  const dollars = micros / 1_000_000;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: dollars < 0.01 ? 4 : 2,
    maximumFractionDigits: dollars < 0.01 ? 4 : 2,
  }).format(dollars);
}

export interface StoredAttempt {
  index: number;
  answer: string | null;
  passed: boolean;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface StoredFinding {
  code: string;
  blocking: boolean;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the `attempts` JSON column defensively: a malformed row shows nothing, not a crash. */
export function readAttempts(value: unknown): StoredAttempt[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((row, position) => ({
    index: typeof row.index === 'number' ? row.index : position,
    answer: typeof row.answer === 'string' ? row.answer : null,
    passed: row.passed === true,
    error: typeof row.error === 'string' && row.error.length > 0 ? row.error : null,
    inputTokens: typeof row.inputTokens === 'number' ? row.inputTokens : 0,
    outputTokens: typeof row.outputTokens === 'number' ? row.outputTokens : 0,
    durationMs: typeof row.durationMs === 'number' ? row.durationMs : 0,
  }));
}

export function readFindings(value: unknown): StoredFinding[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter((row) => typeof row.message === 'string')
    .map((row) => ({
      code: typeof row.code === 'string' ? row.code : 'UNKNOWN',
      blocking: row.blocking === true,
      message: row.message as string,
    }));
}
