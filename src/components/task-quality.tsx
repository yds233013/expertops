import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import type { TaskSpec, TaskVerdict } from '@/server/domain/task-checks';
import {
  describeChecker,
  formatCostMicros,
  readAttempts,
  readFindings,
  VERDICT_GUIDANCE,
  VERDICT_LABEL,
  VERDICT_TONE,
} from '@/lib/task-quality-format';
import { formatRelative } from '@/lib/time';
import { Badge, ProportionBar, ProvenanceTag } from '@/components/ui';

/**
 * Task-check furniture: the verdict, who attempted it, and how often it was
 * solved. No hooks, so the operator pages render it on the server and the
 * portal can reuse the task view in a client component.
 */

export function VerdictBadge({
  verdict,
  status,
}: {
  verdict: TaskVerdict | null;
  status?: 'COMPLETED' | 'INCONCLUSIVE' | string;
}) {
  if (!verdict || status === 'INCONCLUSIVE') {
    return (
      <Badge tone="muted" title="Too few model attempts returned a reply to reach a verdict.">
        Inconclusive
      </Badge>
    );
  }
  return (
    <Badge tone={VERDICT_TONE[verdict]} title={VERDICT_GUIDANCE[verdict]}>
      {VERDICT_LABEL[verdict]}
    </Badge>
  );
}

/** Who made the attempts. A simulated run is labelled every time it appears. */
export function SolverTag({ provider, model }: { provider: string; model?: string }) {
  if (provider === 'simulated') {
    return (
      <ProvenanceTag
        kind="simulated"
        label="Simulated solver"
        title="Attempts came from a deterministic stand-in, not a real model. The verdict shows how the check works, not how hard the task is."
      />
    );
  }
  return (
    <ProvenanceTag
      kind="automated"
      label={model ? `Model · ${model}` : 'Model'}
      title="Attempts were made by calling the model API from the background worker."
    />
  );
}

/** "3 of 4 solved", with a bar. Errored attempts are left out of both numbers. */
export function SolvedCount({
  passes,
  valid,
  verdict,
}: {
  passes: number;
  valid: number;
  verdict?: TaskVerdict | null;
}) {
  if (valid === 0) {
    return (
      <span className="text-xs text-ink-400">
        {verdict === 'BROKEN_SPEC' || verdict === 'ANSWER_LEAK' ? 'Not attempted' : 'No replies'}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <ProportionBar
        value={passes}
        max={valid}
        tone={passes === valid ? 'warning' : 'accent'}
        className="w-14"
      />
      <span className="text-xs tabular-nums text-ink-700">
        {passes} of {valid} solved
      </span>
    </span>
  );
}

/** One pill per attempt: solved, missed or errored. */
export function AttemptsStrip({ attempts }: { attempts: unknown }) {
  const rows = readAttempts(attempts);
  if (rows.length === 0) return null;
  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label="Model attempts">
      {rows.map((attempt) => {
        const state = attempt.error ? 'error' : attempt.passed ? 'pass' : 'miss';
        const description =
          state === 'error'
            ? `Attempt ${attempt.index + 1}: the call failed (${attempt.error})`
            : `Attempt ${attempt.index + 1}: ${state === 'pass' ? 'solved' : 'missed'}, answered ${attempt.answer === null ? 'nothing' : `“${attempt.answer}”`}`;
        return (
          <li
            key={attempt.index}
            title={description}
            className={clsx(
              'inline-flex h-5 min-w-5 items-center justify-center rounded px-1 text-[0.65rem] font-semibold tabular-nums',
              state === 'pass' && 'bg-emerald-600 text-white',
              state === 'miss' && 'border border-ink-300 bg-ink-100 text-ink-600',
              state === 'error' && 'bg-rose-600 text-white',
            )}
          >
            <span aria-hidden="true">{attempt.index + 1}</span>
            <span className="sr-only">{description}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** A submitted task: prompt folded away, reference answer and checker in words. */
export function TaskSpecView({
  spec,
  promptOpen = false,
}: {
  spec: TaskSpec;
  promptOpen?: boolean;
}) {
  return (
    <div className="space-y-2">
      <details className="group rounded-md border border-ink-200 bg-ink-50/60" open={promptOpen}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-md px-3 py-2 text-xs font-semibold text-ink-700">
          <span>
            Prompt{' '}
            <span className="font-normal text-ink-500">
              · {spec.prompt.length.toLocaleString('en-US')} characters
            </span>
          </span>
          <span
            aria-hidden="true"
            className="text-ink-400 transition-transform group-open:rotate-90"
          >
            &rsaquo;
          </span>
        </summary>
        <p className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-ink-200 px-3 py-2 text-sm text-ink-800 break-anywhere">
          {spec.prompt}
        </p>
      </details>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)]">
        <dt className="text-xs font-semibold text-ink-500 sm:pt-0.5">Reference answer</dt>
        <dd className="font-mono text-[0.8rem] text-ink-900 break-anywhere">
          {spec.referenceAnswer}
        </dd>
        <dt className="text-xs font-semibold text-ink-500 sm:pt-0.5">Checker</dt>
        <dd className="text-ink-800 break-anywhere">{describeChecker(spec.checker)}</dd>
      </dl>
    </div>
  );
}

export interface TaskCheckRecord {
  provider: string;
  model: string;
  status: 'COMPLETED' | 'INCONCLUSIVE' | string;
  verdict: TaskVerdict | null;
  requestedAttempts: number;
  validAttempts: number;
  passes: number;
  findings: unknown;
  attempts: unknown;
  inconclusiveReason: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicros: number | null;
  checkedAt: Date;
}

/**
 * The full check for one submission: what the expert wrote, what the model
 * made of it, and what that suggests to the reviewer. Advice, never a decision.
 */
export function TaskCheckDetail({
  spec,
  check,
  actions,
}: {
  spec: TaskSpec;
  check: TaskCheckRecord | null;
  /** The re-run control, for people allowed to use it. */
  actions?: ReactNode;
}) {
  const findings = check ? readFindings(check.findings) : [];
  const attempts = check ? readAttempts(check.attempts) : [];
  const errored = attempts.filter((attempt) => attempt.error).length;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <section aria-label="Submitted task" className="min-w-0">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
          Submitted task
        </h4>
        <TaskSpecView spec={spec} />
      </section>

      <section aria-label="Automated check" className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            Automated check
          </h4>
          {actions}
        </div>

        {!check ? (
          <p className="rounded-md border border-dashed border-ink-300 px-3 py-2.5 text-sm text-ink-600">
            Check queued — the worker runs it in the background. Reload in a minute to see the
            result.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <VerdictBadge verdict={check.verdict} status={check.status} />
              <SolverTag provider={check.provider} model={check.model} />
              <span className="text-xs text-ink-500">
                checked {formatRelative(check.checkedAt)}
              </span>
            </div>
            <p className="text-sm text-ink-700">
              {check.verdict && check.status !== 'INCONCLUSIVE'
                ? VERDICT_GUIDANCE[check.verdict]
                : (check.inconclusiveReason ??
                  'Too few attempts returned a reply. Re-run the check.')}
            </p>

            {findings.length > 0 && (
              <ul className="space-y-1">
                {findings.map((finding) => (
                  <li
                    key={finding.code}
                    className={clsx(
                      'flex gap-2 rounded-md px-2.5 py-1.5 text-xs',
                      finding.blocking ? 'bg-rose-50 text-rose-900' : 'bg-amber-50 text-amber-900',
                    )}
                  >
                    <span className="shrink-0 font-semibold">
                      {finding.blocking ? 'Blocking' : 'Note'}
                    </span>
                    <span>{finding.message}</span>
                  </li>
                ))}
              </ul>
            )}

            {attempts.length > 0 ? (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <AttemptsStrip attempts={check.attempts} />
                  <SolvedCount
                    passes={check.passes}
                    valid={check.validAttempts}
                    verdict={check.verdict}
                  />
                  {errored > 0 && (
                    <span className="text-xs text-rose-800">
                      {errored} call{errored === 1 ? '' : 's'} failed
                    </span>
                  )}
                </div>
                <details className="text-xs">
                  <summary className="cursor-pointer font-semibold text-accent-700 hover:underline">
                    Show the answers
                  </summary>
                  <div className="scroll-x mt-1.5 rounded-md border border-ink-200">
                    <table className="data">
                      <thead>
                        <tr>
                          <th scope="col">Attempt</th>
                          <th scope="col">Result</th>
                          <th scope="col">Final answer</th>
                          <th scope="col" className="text-right">
                            Time
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {attempts.map((attempt) => (
                          <tr key={attempt.index}>
                            <td className="tabular-nums">{attempt.index + 1}</td>
                            <td>
                              {attempt.error ? (
                                <Badge tone="danger" title={attempt.error}>
                                  error
                                </Badge>
                              ) : attempt.passed ? (
                                <Badge tone="success">solved</Badge>
                              ) : (
                                <Badge tone="muted">missed</Badge>
                              )}
                            </td>
                            <td className="max-w-[16rem] font-mono text-[0.75rem] break-anywhere">
                              {attempt.error ?? attempt.answer ?? (
                                <span className="font-sans text-ink-400">No FINAL line</span>
                              )}
                            </td>
                            <td className="text-right tabular-nums text-ink-500">
                              {(attempt.durationMs / 1000).toFixed(1)}s
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            ) : (
              <p className="text-xs text-ink-500">
                No model attempts were made: a blocking finding means any attempt would prove
                nothing.
              </p>
            )}

            {check.provider !== 'simulated' &&
              (check.inputTokens > 0 || check.outputTokens > 0) && (
                <p className="text-xs tabular-nums text-ink-500">
                  {check.inputTokens.toLocaleString('en-US')} input ·{' '}
                  {check.outputTokens.toLocaleString('en-US')} output tokens
                  {check.estimatedCostMicros !== null
                    ? ` · est. ${formatCostMicros(check.estimatedCostMicros)}`
                    : ' · no price on file for this model'}
                </p>
              )}
          </div>
        )}
      </section>
    </div>
  );
}
