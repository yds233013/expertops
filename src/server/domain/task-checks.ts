import { z } from 'zod';

/**
 * Task quality checks: the pure part.
 *
 * An expert on an evals project does not hand in "a deliverable". They hand in
 * a task: a prompt, a reference answer, and a rule that decides whether some
 * other answer is right. Three things go wrong with tasks often enough that a
 * reviewer should never have to discover them by hand:
 *
 *  1. **The task is broken.** The reference answer fails its own checker, or
 *     the checker cannot run. Every model will "fail" it and the failure means
 *     nothing.
 *  2. **The task leaks its answer.** The reference answer is sitting in the
 *     prompt. Every model will "pass" it and the pass means nothing.
 *  3. **The task is too easy.** A frontier model solves it every time. It does
 *     not measure anything a lab is paying to measure.
 *
 * This module decides which of those applies. It does no I/O: the model runs
 * happen elsewhere and arrive here as a list of attempts, so every rule below is
 * unit-testable and deterministic.
 *
 * A verdict is **advice to the reviewer**, never a decision. Nothing here
 * approves, rejects or pays for a submission.
 */

// ---------------------------------------------------------------------------
// Task specification
// ---------------------------------------------------------------------------

/** Longest regex pattern accepted. Patterns run against model output. */
export const MAX_REGEX_LENGTH = 300;
/** Longest model answer a checker will look at. Anything longer is cut first. */
export const MAX_ANSWER_LENGTH = 2000;

export const checkerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('EXACT'),
    /** Off by default: "Paris" and "paris" are the same answer to most tasks. */
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('NUMERIC'),
    /** Absolute tolerance. 0 means the number must match exactly. */
    tolerance: z.number().min(0).max(1e12).default(0),
  }),
  z.object({
    kind: z.literal('REGEX'),
    pattern: z.string().min(1).max(MAX_REGEX_LENGTH),
  }),
]);

export type TaskChecker = z.infer<typeof checkerSchema>;
export type TaskCheckerKind = TaskChecker['kind'];

export const taskSpecSchema = z.object({
  prompt: z.string().trim().min(1, 'A task needs a prompt.').max(20_000),
  referenceAnswer: z.string().trim().min(1, 'A task needs a reference answer.').max(2_000),
  checker: checkerSchema,
});

export type TaskSpec = z.infer<typeof taskSpecSchema>;

/** Parse an untrusted value, e.g. a JSON column or a request body. */
export function parseTaskSpec(value: unknown): TaskSpec {
  return taskSpecSchema.parse(value);
}

// ---------------------------------------------------------------------------
// Checking an answer
// ---------------------------------------------------------------------------

function normaliseText(value: string, caseSensitive: boolean): string {
  const collapsed = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  // A trailing full stop is punctuation, not part of the answer.
  const stripped = collapsed.replace(/[.。]+$/, '');
  return caseSensitive ? stripped : stripped.toLowerCase();
}

/**
 * Read one number out of an answer.
 *
 * Accepts thousands separators, a leading currency sign and a trailing percent
 * sign, because "$1,250" and "1250" are the same answer. Refuses anything with
 * more than one number in it: "between 3 and 5" is not an answer of 3.
 */
export function parseNumber(value: string): number | null {
  const cleaned = value
    .trim()
    .replace(/^[$€£¥]/, '')
    .replace(/%$/, '')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export class CheckerError extends Error {}

/** Compile a checker's regex once, or explain why it cannot be compiled. */
export function compileRegex(pattern: string): RegExp {
  if (pattern.length > MAX_REGEX_LENGTH) {
    throw new CheckerError(`The pattern is longer than ${MAX_REGEX_LENGTH} characters.`);
  }
  try {
    return new RegExp(pattern, 'iu');
  } catch (error) {
    throw new CheckerError(
      `The pattern does not compile: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Does `answer` satisfy the checker for a task whose reference is `reference`?
 *
 * Throws `CheckerError` only when the checker itself is unusable. A wrong
 * answer is `false`, never an exception.
 */
export function answerPasses(checker: TaskChecker, reference: string, answer: string): boolean {
  const candidate = answer.slice(0, MAX_ANSWER_LENGTH);
  switch (checker.kind) {
    case 'EXACT':
      return (
        normaliseText(candidate, checker.caseSensitive) ===
        normaliseText(reference, checker.caseSensitive)
      );
    case 'NUMERIC': {
      const expected = parseNumber(reference);
      if (expected === null) {
        throw new CheckerError('The reference answer is not a single number.');
      }
      const actual = parseNumber(candidate);
      if (actual === null) return false;
      return Math.abs(actual - expected) <= checker.tolerance;
    }
    case 'REGEX': {
      // Anchored so that "12" does not pass a pattern meant for "1234".
      const regex = compileRegex(`^(?:${checker.pattern})$`);
      return regex.test(candidate.trim());
    }
  }
}

/**
 * Pull the final answer out of a model's reply.
 *
 * Models are asked to end with a line `FINAL: <answer>`. The last such line
 * wins, so a model that corrects itself is graded on its correction. A reply
 * with no such line has no answer, which counts as a miss, not an error.
 */
export function extractFinalAnswer(reply: string): string | null {
  const matches = [...reply.matchAll(/^\s*\**FINAL\**\s*:\s*(.+?)\s*$/gim)];
  const last = matches.at(-1);
  if (!last) return null;
  const value = (last[1] ?? '').replace(/^\*+|\*+$/g, '').trim();
  return value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Structural checks (no model needed)
// ---------------------------------------------------------------------------

export type FindingCode =
  'REFERENCE_FAILS_CHECKER' | 'CHECKER_UNUSABLE' | 'ANSWER_IN_PROMPT' | 'PROMPT_VERY_SHORT';

export interface Finding {
  code: FindingCode;
  /** Blocking findings mean model runs would prove nothing, so none are made. */
  blocking: boolean;
  message: string;
}

/** Below this length a prompt is flagged, not refused: some good tasks are short. */
export const SHORT_PROMPT_CHARS = 80;
/** A reference shorter than this is too common to call a leak ("4", "yes"). */
const MIN_LEAK_LENGTH = 4;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Is the reference named as one of the choices a solver is given?
 *
 * "Answer Buyer or Seller" has to contain the answer, and that is not a leak.
 * Recognised: "X or Y", "X/Y", and "one of: X, Y". Anything else that contains
 * the answer is treated as a leak.
 */
function offeredAsOption(prompt: string, reference: string): boolean {
  const ref = escapeRegex(reference);
  const patterns = [
    new RegExp(`(^|[^a-z0-9])${ref}\\s+or\\s+\\S`, 'u'),
    new RegExp(`\\sor\\s+${ref}([^a-z0-9]|$)`, 'u'),
    new RegExp(`(^|[^a-z0-9])${ref}\\s*/\\s*\\S|\\S\\s*/\\s*${ref}([^a-z0-9]|$)`, 'u'),
    new RegExp(`one of[:\\s][^.?!]*${ref}`, 'u'),
  ];
  return patterns.some((pattern) => pattern.test(prompt));
}

export function structuralFindings(spec: TaskSpec): Finding[] {
  const findings: Finding[] = [];

  try {
    if (!answerPasses(spec.checker, spec.referenceAnswer, spec.referenceAnswer)) {
      findings.push({
        code: 'REFERENCE_FAILS_CHECKER',
        blocking: true,
        message:
          'The reference answer does not pass its own checker, so no answer could ever be marked right.',
      });
    }
  } catch (error) {
    findings.push({
      code: 'CHECKER_UNUSABLE',
      blocking: true,
      message: error instanceof Error ? error.message : 'The checker cannot run.',
    });
  }

  const reference = normaliseText(spec.referenceAnswer, false);
  const prompt = normaliseText(spec.prompt, false);
  if (
    reference.length >= MIN_LEAK_LENGTH &&
    prompt.includes(reference) &&
    !offeredAsOption(prompt, reference)
  ) {
    findings.push({
      code: 'ANSWER_IN_PROMPT',
      blocking: true,
      message: 'The reference answer appears word for word in the prompt.',
    });
  }

  if (spec.prompt.trim().length < SHORT_PROMPT_CHARS) {
    findings.push({
      code: 'PROMPT_VERY_SHORT',
      blocking: false,
      message: `The prompt is under ${SHORT_PROMPT_CHARS} characters. Check it says everything a solver needs.`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type TaskVerdict =
  /** The reference fails its own checker, or the checker cannot run. */
  | 'BROKEN_SPEC'
  /** The answer is in the prompt. */
  | 'ANSWER_LEAK'
  /** The model solved it on every valid attempt. */
  | 'TOO_EASY'
  /** The model solved it on some attempts and not others: it separates models. */
  | 'DISCRIMINATING'
  /** The model never solved it. Either a hard task or a wrong reference. */
  | 'UNSOLVED';

export interface AttemptOutcome {
  /** The answer extracted from the reply, or null when there was none. */
  answer: string | null;
  passed: boolean;
  /** Set when the call itself failed. Errored attempts do not count either way. */
  error?: string;
}

export interface VerdictResult {
  verdict: TaskVerdict | null;
  /** Attempts that returned a reply, whether or not it was right. */
  validAttempts: number;
  passes: number;
  /** Null verdict with a reason: too many calls failed to say anything. */
  inconclusiveReason?: string;
}

/**
 * Decide the verdict from structural findings and model attempts.
 *
 * At least half the requested attempts must have produced a reply. Fewer than
 * that and the result is inconclusive rather than a guess: two replies out of
 * five is not a pass rate.
 */
export function decideVerdict(
  findings: Finding[],
  attempts: AttemptOutcome[],
  requestedAttempts: number,
): VerdictResult {
  if (findings.some((finding) => finding.code === 'ANSWER_IN_PROMPT')) {
    return { verdict: 'ANSWER_LEAK', validAttempts: 0, passes: 0 };
  }
  if (findings.some((finding) => finding.blocking)) {
    return { verdict: 'BROKEN_SPEC', validAttempts: 0, passes: 0 };
  }

  const valid = attempts.filter((attempt) => !attempt.error);
  const passes = valid.filter((attempt) => attempt.passed).length;
  const needed = Math.max(1, Math.ceil(requestedAttempts / 2));

  if (valid.length < needed) {
    return {
      verdict: null,
      validAttempts: valid.length,
      passes,
      inconclusiveReason: `Only ${valid.length} of ${requestedAttempts} model attempts returned a reply; at least ${needed} are needed.`,
    };
  }

  const verdict: TaskVerdict =
    passes === valid.length ? 'TOO_EASY' : passes === 0 ? 'UNSOLVED' : 'DISCRIMINATING';
  return { verdict, validAttempts: valid.length, passes };
}

/** Verdicts a reviewer should look at before approving. */
export const VERDICTS_NEEDING_ATTENTION: readonly TaskVerdict[] = [
  'BROKEN_SPEC',
  'ANSWER_LEAK',
  'TOO_EASY',
];

/** One plain sentence per verdict, for the reviewer. */
export const VERDICT_GUIDANCE: Record<TaskVerdict, string> = {
  BROKEN_SPEC:
    'The task cannot be graded as written. Ask the expert to fix the checker or reference.',
  ANSWER_LEAK: 'The prompt gives the answer away. Ask the expert to remove it.',
  TOO_EASY: 'The model solved it every time. It is unlikely to measure anything new.',
  DISCRIMINATING: 'The model solved it some of the time. This is a task that separates models.',
  UNSOLVED:
    'The model never solved it. Check the reference answer is right before treating it as hard.',
};
