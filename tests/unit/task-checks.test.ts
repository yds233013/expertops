import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  answerPasses,
  CheckerError,
  decideVerdict,
  extractFinalAnswer,
  parseNumber,
  parseTaskSpec,
  structuralFindings,
  type AttemptOutcome,
  type TaskSpec,
} from '@/server/domain/task-checks';
import {
  AnthropicSolver,
  estimateCostMicros,
  SimulatedSolver,
  taskCheckConfig,
} from '@/server/services/task-solver';

const longPrompt =
  'A retailer sells 1,200 units a month at $25 with a 40% gross margin. Fixed costs are $9,000 a month. What is the monthly operating profit in dollars?';

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    prompt: longPrompt,
    referenceAnswer: '3000',
    checker: { kind: 'NUMERIC', tolerance: 0 },
    ...overrides,
  };
}

const hit: AttemptOutcome = { answer: '3000', passed: true };
const miss: AttemptOutcome = { answer: '2000', passed: false };
const failed: AttemptOutcome = { answer: null, passed: false, error: 'timeout' };

describe('task specification', () => {
  it('applies checker defaults and trims text', () => {
    const parsed = parseTaskSpec({
      prompt: `  ${longPrompt}  `,
      referenceAnswer: ' Paris ',
      checker: { kind: 'EXACT' },
    });
    expect(parsed.referenceAnswer).toBe('Paris');
    expect(parsed.checker).toEqual({ kind: 'EXACT', caseSensitive: false });
  });

  it('refuses an unknown checker kind and an empty reference', () => {
    expect(() =>
      parseTaskSpec({ prompt: 'x', referenceAnswer: 'y', checker: { kind: 'LLM_JUDGE' } }),
    ).toThrow();
    expect(() =>
      parseTaskSpec({ prompt: 'x', referenceAnswer: '   ', checker: { kind: 'EXACT' } }),
    ).toThrow();
  });
});

describe('answer checking', () => {
  it('matches exact answers ignoring case, spacing and a trailing full stop', () => {
    const checker = { kind: 'EXACT', caseSensitive: false } as const;
    expect(answerPasses(checker, 'New York', '  new   york. ')).toBe(true);
    expect(answerPasses(checker, 'New York', 'York')).toBe(false);
    expect(answerPasses({ kind: 'EXACT', caseSensitive: true }, 'pH', 'PH')).toBe(false);
  });

  it('reads numbers with separators, currency and percent signs', () => {
    expect(parseNumber('$1,250')).toBe(1250);
    expect(parseNumber('12.5%')).toBe(12.5);
    expect(parseNumber('-3e2')).toBe(-300);
    expect(parseNumber('between 3 and 5')).toBeNull();
    expect(parseNumber('1,25')).toBeNull();
  });

  it('applies numeric tolerance in both directions', () => {
    const checker = { kind: 'NUMERIC', tolerance: 0.01 } as const;
    expect(answerPasses(checker, '3.14', '3.149')).toBe(true);
    expect(answerPasses(checker, '3.14', '3.131')).toBe(true);
    expect(answerPasses(checker, '3.14', '3.16')).toBe(false);
    expect(answerPasses(checker, '3.14', 'about pi')).toBe(false);
  });

  it('anchors regex patterns so a partial match does not pass', () => {
    const checker = { kind: 'REGEX', pattern: 'CVE-2024-\\d{4,5}' } as const;
    expect(answerPasses(checker, 'CVE-2024-3094', 'cve-2024-3094')).toBe(true);
    expect(answerPasses(checker, 'CVE-2024-3094', 'See CVE-2024-3094 for details')).toBe(false);
  });

  it('raises a checker error, not a miss, when the checker itself is unusable', () => {
    expect(() => answerPasses({ kind: 'REGEX', pattern: '([a-z' }, 'a', 'a')).toThrow(CheckerError);
    expect(() => answerPasses({ kind: 'NUMERIC', tolerance: 0 }, 'ten', '10')).toThrow(
      CheckerError,
    );
  });
});

describe('final answer extraction', () => {
  it('takes the last FINAL line, so a corrected answer wins', () => {
    expect(extractFinalAnswer('Working...\nFINAL: 12\nWait, recheck.\nFINAL: 14')).toBe('14');
  });

  it('accepts bold markdown around the marker', () => {
    expect(extractFinalAnswer('**FINAL:** Paris')).toBe('Paris');
  });

  it('returns null when there is no answer line', () => {
    expect(extractFinalAnswer('The answer is probably 12.')).toBeNull();
    expect(extractFinalAnswer('FINAL:   ')).toBeNull();
  });
});

describe('structural findings', () => {
  it('finds nothing wrong with a sound task', () => {
    expect(structuralFindings(spec())).toEqual([]);
  });

  it('blocks a task whose reference fails its own checker', () => {
    const findings = structuralFindings(
      spec({ referenceAnswer: '3000', checker: { kind: 'REGEX', pattern: '[a-z]+' } }),
    );
    expect(findings.map((finding) => finding.code)).toEqual(['REFERENCE_FAILS_CHECKER']);
    expect(findings[0]?.blocking).toBe(true);
  });

  it('blocks a task whose checker cannot run', () => {
    const findings = structuralFindings(spec({ referenceAnswer: 'three thousand' }));
    expect(findings.map((finding) => finding.code)).toEqual(['CHECKER_UNUSABLE']);
  });

  it('flags an answer that appears in the prompt, but not a short common one', () => {
    const leaking = structuralFindings(
      spec({
        prompt: `${longPrompt} (Hint: the operating profit is 3,000 dollars, i.e. Paris Accord.)`,
        referenceAnswer: 'Paris Accord',
        checker: { kind: 'EXACT', caseSensitive: false },
      }),
    );
    expect(leaking.map((finding) => finding.code)).toContain('ANSWER_IN_PROMPT');

    const shortReference = structuralFindings(
      spec({
        prompt: `${longPrompt} Give 1 number.`,
        referenceAnswer: '1',
        checker: { kind: 'NUMERIC', tolerance: 0 },
      }),
    );
    expect(shortReference.map((finding) => finding.code)).not.toContain('ANSWER_IN_PROMPT');
  });

  it('does not call a named choice a leak', () => {
    for (const prompt of [
      `${longPrompt} Answer Buyer or Seller.`,
      `${longPrompt} Answer Seller or Buyer.`,
      `${longPrompt} Reply Buyer/Seller.`,
      `${longPrompt} Choose one of: Seller, Buyer, neither.`,
    ]) {
      const findings = structuralFindings(
        spec({
          prompt,
          referenceAnswer: 'Buyer',
          checker: { kind: 'EXACT', caseSensitive: false },
        }),
      );
      expect(
        findings.map((finding) => finding.code),
        prompt,
      ).not.toContain('ANSWER_IN_PROMPT');
    }
    const leaking = structuralFindings(
      spec({
        prompt: `${longPrompt} The Buyer bears the loss here.`,
        referenceAnswer: 'Buyer',
        checker: { kind: 'EXACT', caseSensitive: false },
      }),
    );
    expect(leaking.map((finding) => finding.code)).toContain('ANSWER_IN_PROMPT');
  });

  it('warns about a very short prompt without blocking', () => {
    const findings = structuralFindings(spec({ prompt: 'What is 2 + 2?', referenceAnswer: '4' }));
    expect(findings).toEqual([
      expect.objectContaining({ code: 'PROMPT_VERY_SHORT', blocking: false }),
    ]);
  });
});

describe('verdicts', () => {
  it('calls a task solved on every attempt too easy', () => {
    expect(decideVerdict([], [hit, hit, hit, hit], 4)).toMatchObject({
      verdict: 'TOO_EASY',
      passes: 4,
      validAttempts: 4,
    });
  });

  it('calls a mixed result discriminating and a total miss unsolved', () => {
    expect(decideVerdict([], [hit, miss, miss, hit], 4).verdict).toBe('DISCRIMINATING');
    expect(decideVerdict([], [miss, miss, miss, miss], 4).verdict).toBe('UNSOLVED');
  });

  it('ignores errored attempts when they leave enough valid ones', () => {
    expect(decideVerdict([], [hit, hit, failed, failed], 4)).toMatchObject({
      verdict: 'TOO_EASY',
      validAttempts: 2,
    });
  });

  it('is inconclusive when fewer than half the attempts replied', () => {
    const result = decideVerdict([], [hit, failed, failed, failed], 4);
    expect(result.verdict).toBeNull();
    expect(result.inconclusiveReason).toMatch(/1 of 4/);
  });

  it('lets structural problems override any attempt', () => {
    const broken = structuralFindings(spec({ referenceAnswer: 'three thousand' }));
    expect(decideVerdict(broken, [], 4).verdict).toBe('BROKEN_SPEC');
    const leak = [{ code: 'ANSWER_IN_PROMPT' as const, blocking: true, message: '' }];
    expect(decideVerdict(leak, [], 4).verdict).toBe('ANSWER_LEAK');
  });
});

describe('simulated solver', () => {
  it('gives the same attempts for the same submission every time', async () => {
    const solver = new SimulatedSolver();
    const run = () =>
      Promise.all([0, 1, 2, 3].map((index) => solver.attempt(spec(), { seed: 'sub-1', index })));
    const [first, second] = await Promise.all([run(), run()]);
    expect(first.map((attempt) => attempt.passed)).toEqual(second.map((attempt) => attempt.passed));
    for (const attempt of first) {
      expect(attempt.passed).toBe(attempt.answer === '3000');
    }
  });
});

describe('check configuration', () => {
  it('defaults to the simulated provider so nothing is billed by accident', () => {
    expect(taskCheckConfig({}).provider).toBe('simulated');
    expect(taskCheckConfig({ TASK_CHECK_PROVIDER: 'anthropic' }).provider).toBe('anthropic');
  });

  it('clamps attempts and timeout to stay inside the worker lease', () => {
    const config = taskCheckConfig({ TASK_CHECK_ATTEMPTS: '50', TASK_CHECK_TIMEOUT_MS: '999999' });
    expect(config.attempts).toBe(8);
    expect(config.timeoutMs).toBe(80_000);
    expect(taskCheckConfig({ TASK_CHECK_EFFORT: 'extreme' }).effort).toBe('medium');
  });

  it('estimates cost only for models with a known price', () => {
    expect(estimateCostMicros('claude-opus-5-5', 1_000, 500)).toBe(14_000);
    expect(estimateCostMicros('some-other-model', 1_000, 500)).toBeNull();
  });
});

describe('anthropic solver', () => {
  type CreateArgs = Record<string, unknown>;
  function fakeClient(respond: (args: CreateArgs) => unknown) {
    const calls: CreateArgs[] = [];
    const client = {
      beta: {
        messages: {
          create: async (args: CreateArgs) => {
            calls.push(args);
            const result = respond(args);
            if (result instanceof Error) throw result;
            return result;
          },
        },
      },
    };
    return { client: client as unknown as Anthropic, calls };
  }

  const message = (text: string, stop_reason = 'end_turn') => ({
    stop_reason,
    content: [{ type: 'text', text }],
    usage: { input_tokens: 120, output_tokens: 40 },
  });

  const options = {
    model: 'claude-opus-5-5',
    effort: 'medium' as const,
    timeoutMs: 10_000,
    maxTokens: 16_000,
  };

  it('sends the task with fallbacks and effort, and grades the final line', async () => {
    const { client, calls } = fakeClient(() =>
      message('Margin is 30,000; less 9,000.\nFINAL: 3000'),
    );
    const attempt = await new AnthropicSolver({ ...options, client }).attempt(spec());

    expect(attempt).toMatchObject({
      answer: '3000',
      passed: true,
      inputTokens: 120,
      outputTokens: 40,
    });
    expect(calls[0]).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: longPrompt }],
    });
  });

  it('records a refusal as an errored attempt, not a miss', async () => {
    const { client } = fakeClient(() => ({ ...message(''), stop_reason: 'refusal' }));
    const attempt = await new AnthropicSolver({ ...options, client }).attempt(spec());
    expect(attempt.error).toMatch(/declined/);
  });

  it('records a reply cut off before its answer as an error', async () => {
    const { client } = fakeClient(() => message('Let me think about this at length', 'max_tokens'));
    const attempt = await new AnthropicSolver({ ...options, client }).attempt(spec());
    expect(attempt.error).toMatch(/token limit/);
  });

  it('turns a thrown API error into an errored attempt', async () => {
    const { client } = fakeClient(() => new Error('socket hang up'));
    const attempt = await new AnthropicSolver({ ...options, client }).attempt(spec());
    expect(attempt).toMatchObject({ passed: false, error: 'socket hang up' });
  });
});
