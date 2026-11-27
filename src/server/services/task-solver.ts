import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import {
  answerPasses,
  CheckerError,
  extractFinalAnswer,
  type AttemptOutcome,
  type TaskSpec,
} from '@/server/domain/task-checks';

/**
 * Who attempts a task.
 *
 * Two implementations behind one interface:
 *
 *  - `anthropic` calls the Claude API. Used only when `TASK_CHECK_PROVIDER` is
 *    `anthropic` and credentials resolve. It costs money per attempt, so it is
 *    never the default.
 *  - `simulated` is deterministic: the same submission always gets the same
 *    attempts. It exists so the demo, the seed and the test suite exercise the
 *    whole pipeline without a network call, and the UI labels its results as
 *    simulated everywhere they appear.
 *
 * A solver only ever *reads*: an attempt has no effect outside this process
 * beyond the API bill. That is what makes it safe to call from inside the
 * worker's job transaction. If the transaction rolls back after a lease
 * takeover, the only thing lost is the money for those attempts; the result is
 * not double-recorded, because a check row is unique per submission.
 */
export interface SolverAttempt extends AttemptOutcome {
  /** The raw reply, trimmed for storage. */
  reply: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface TaskSolver {
  readonly provider: 'anthropic' | 'simulated';
  readonly model: string;
  attempt(spec: TaskSpec, context: { seed: string; index: number }): Promise<SolverAttempt>;
}

/** Stored replies are capped. A reviewer needs the gist, not a novel. */
const MAX_STORED_REPLY = 4000;

/**
 * The instruction every solver gets. Kept short and fixed: the task's own
 * prompt carries the difficulty, and a stable system prompt caches well.
 */
export const SOLVER_SYSTEM_PROMPT = [
  'You are being evaluated on a task written by a domain expert.',
  'Work through it however you need to, then finish your reply with exactly one line of the form:',
  'FINAL: <your answer>',
  'Put only the answer on that line, with no explanation.',
].join('\n');

function grade(spec: TaskSpec, reply: string): Pick<AttemptOutcome, 'answer' | 'passed'> {
  const answer = extractFinalAnswer(reply);
  if (answer === null) return { answer: null, passed: false };
  try {
    return { answer, passed: answerPasses(spec.checker, spec.referenceAnswer, answer) };
  } catch (error) {
    // Structural checks run first and stop unusable checkers, so reaching this
    // means the checker broke on this particular answer. Count it as a miss.
    if (error instanceof CheckerError) return { answer, passed: false };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Simulated
// ---------------------------------------------------------------------------

function unitInterval(input: string): number {
  const digest = createHash('sha256').update(input).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

/**
 * A stand-in model with a fixed, per-task "skill".
 *
 * The probability of solving a task is drawn from a hash of its prompt, so the
 * same task is equally hard every time it is checked and different tasks land
 * in different bands. Each attempt then succeeds or fails from a hash of the
 * submission and the attempt number. No randomness, no clock.
 */
export class SimulatedSolver implements TaskSolver {
  readonly provider = 'simulated' as const;
  readonly model = 'simulated-solver-v1';

  async attempt(spec: TaskSpec, context: { seed: string; index: number }): Promise<SolverAttempt> {
    const solveRate = unitInterval(`rate:${spec.prompt}`);
    const roll = unitInterval(`attempt:${context.seed}:${context.index}`);
    const answer = roll < solveRate ? spec.referenceAnswer : 'I am not certain.';
    const reply = `Simulated attempt ${context.index + 1}.\nFINAL: ${answer}`;
    return {
      ...grade(spec, reply),
      reply,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

export interface AnthropicSolverOptions {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs: number;
  maxTokens: number;
  client?: Anthropic;
}

export class AnthropicSolver implements TaskSolver {
  readonly provider = 'anthropic' as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicSolverOptions) {
    this.model = options.model;
    // Retries are the SDK's: 429, 5xx and connection errors, with backoff.
    this.client = options.client ?? new Anthropic({ timeout: options.timeoutMs, maxRetries: 1 });
  }

  async attempt(spec: TaskSpec): Promise<SolverAttempt> {
    const started = Date.now();
    try {
      const response = await this.client.beta.messages.create({
        model: this.options.model,
        max_tokens: this.options.maxTokens,
        // A refused request is retried on a fallback model chosen by the API,
        // so a safety decline on a security task is not recorded as a miss.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: this.options.effort },
        system: [
          { type: 'text', text: SOLVER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: spec.prompt }],
      });

      const usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        durationMs: Date.now() - started,
      };

      if (response.stop_reason === 'refusal') {
        return {
          answer: null,
          passed: false,
          error: 'The model declined the task.',
          reply: '',
          ...usage,
        };
      }

      const reply = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim();

      if (response.stop_reason === 'max_tokens' && extractFinalAnswer(reply) === null) {
        return {
          answer: null,
          passed: false,
          error: 'The reply hit the token limit before giving an answer.',
          reply: reply.slice(-MAX_STORED_REPLY),
          ...usage,
        };
      }

      return { ...grade(spec, reply), reply: reply.slice(-MAX_STORED_REPLY), ...usage };
    } catch (error) {
      return {
        answer: null,
        passed: false,
        error: describeApiError(error),
        reply: '',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - started,
      };
    }
  }
}

function describeApiError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return 'The API key was rejected.';
  if (error instanceof Anthropic.PermissionDeniedError) return 'The API key lacks permission.';
  if (error instanceof Anthropic.RateLimitError) return 'Rate limited by the API.';
  if (error instanceof Anthropic.BadRequestError) return `Bad request: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'The request timed out.';
  if (error instanceof Anthropic.APIConnectionError) return 'Could not reach the API.';
  if (error instanceof Anthropic.APIError) return `API error ${error.status ?? ''}`.trim();
  return error instanceof Error ? error.message : 'Unknown error.';
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TaskCheckConfig {
  provider: 'anthropic' | 'simulated';
  model: string;
  effort: AnthropicSolverOptions['effort'];
  attempts: number;
  timeoutMs: number;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Read the check configuration from the environment.
 *
 * Attempts and timeout are clamped so that all attempts, which run in
 * parallel, finish well inside the worker's 120-second lease.
 */
export function taskCheckConfig(
  env: Record<string, string | undefined> = process.env,
): TaskCheckConfig {
  const effort = EFFORTS.find((value) => value === env.TASK_CHECK_EFFORT) ?? 'medium';
  return {
    provider: env.TASK_CHECK_PROVIDER === 'anthropic' ? 'anthropic' : 'simulated',
    model: env.TASK_CHECK_MODEL?.trim() || 'claude-opus-5-5',
    effort,
    attempts: clampInt(env.TASK_CHECK_ATTEMPTS, 4, 1, 8),
    timeoutMs: clampInt(env.TASK_CHECK_TIMEOUT_MS, 60_000, 5_000, 80_000),
  };
}

export function solverFor(config: TaskCheckConfig): TaskSolver {
  if (config.provider === 'anthropic') {
    return new AnthropicSolver({
      model: config.model,
      effort: config.effort,
      timeoutMs: config.timeoutMs,
      maxTokens: 16_000,
    });
  }
  return new SimulatedSolver();
}

/**
 * Published per-million-token prices, in micro-dollars per token, for the
 * models this build knows. Used for an estimate shown to operators, never for
 * billing. An unknown model shows no cost rather than a wrong one.
 */
const PRICE_MICROS_PER_TOKEN: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

export function estimateCostMicros(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = PRICE_MICROS_PER_TOKEN[model];
  if (!price) return null;
  return Math.round(inputTokens * price.input + outputTokens * price.output);
}
