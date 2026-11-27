import Link from 'next/link';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import type { ScreeningCheckView } from '@/server/services/screening-checks';
import type { FlagSeverity } from '@/server/domain/screening-signals';
import {
  EVIDENCE_KIND_LABEL,
  EVIDENCE_STATUS,
  FLAG_LABELS,
  readEvidence,
  readFlags,
  readSuggestedScores,
  SEVERITY_LABEL,
} from '@/lib/screening-check-format';
import { formatCostMicros } from '@/lib/task-quality-format';
import { formatDateTime, formatRelative } from '@/lib/time';
import { ScreeningRecheckButton } from '@/components/screening-recheck-button';
import { Alert, Badge, ProportionBar, ProvenanceTag } from '@/components/ui';

/**
 * The automated checks on a screening submission, next to the answers they
 * are about.
 *
 * Folded on the review list so ten screenings do not become a wall, and open
 * by default when a flag is serious enough that a reviewer should read it
 * before the answers. Everything here is advice: it never moves the screening.
 */

const SEVERITY_CLASS: Record<FlagSeverity, string> = {
  HIGH: 'border-rose-200 bg-rose-50 text-rose-900',
  MEDIUM: 'border-amber-200 bg-amber-50 text-amber-900',
  LOW: 'border-ink-200 bg-ink-50 text-ink-700',
};

const SEVERITY_TONE: Record<FlagSeverity, 'danger' | 'warning' | 'neutral'> = {
  HIGH: 'danger',
  MEDIUM: 'warning',
  LOW: 'neutral',
};

/** Another screening a flag points at, resolved to the candidate it belongs to. */
export interface RelatedScreening {
  candidateId: string;
  candidateName: string;
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
      {children}
    </h4>
  );
}

export function ScreeningCheckPanel({
  screeningId,
  check,
  passThreshold,
  related,
  canRecheck,
}: {
  screeningId: string;
  /** Null when the latest submission has not been checked yet. */
  check: ScreeningCheckView | null;
  passThreshold: number;
  related: Record<string, RelatedScreening>;
  canRecheck: boolean;
}) {
  const flags = check ? readFlags(check.flags) : [];
  const evidence = check ? readEvidence(check.evidence) : [];
  const scores = check ? readSuggestedScores(check.suggestedScores) : [];
  const serious = flags.filter((flag) => flag.severity !== 'LOW');
  const high = flags.filter((flag) => flag.severity === 'HIGH').length;
  const simulatedScorer = check?.scorerProvider === 'simulated';
  const simulatedEvidence = check?.evidenceMode !== 'live';

  const summary = !check
    ? 'Not checked yet'
    : check.status === 'PENDING'
      ? 'Checking…'
      : flags.length === 0
        ? 'No flags'
        : `${flags.length} ${flags.length === 1 ? 'flag' : 'flags'}${high > 0 ? ` · ${high} high` : ''}`;

  return (
    <details className="group rounded-lg border border-ink-200 bg-white" open={serious.length > 0}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg px-3 py-2.5">
        <span className="text-sm font-semibold text-ink-900">Automated checks</span>
        <Badge tone={high > 0 ? 'danger' : serious.length > 0 ? 'warning' : 'muted'}>
          {summary}
        </Badge>
        {check && (simulatedScorer || simulatedEvidence) && (
          <Badge
            tone="muted"
            title="Some or all of this check came from a stand-in, not a real model or lookup."
          >
            Simulated
          </Badge>
        )}
        <span
          aria-hidden="true"
          className="ml-auto text-ink-400 transition-transform group-open:rotate-90"
        >
          &rsaquo;
        </span>
      </summary>

      <div className="space-y-4 border-t border-ink-100 px-3 pb-3 pt-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="max-w-prose text-xs text-ink-600">
            Advice for the reviewer. It does not score, move or decide this screening.
          </p>
          {canRecheck && <ScreeningRecheckButton screeningId={screeningId} />}
        </div>

        {!check ? (
          <p className="rounded-md border border-dashed border-ink-300 px-3 py-2.5 text-sm text-ink-600">
            This submission has not been checked. Checks run in the background after each
            submission.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
              {simulatedScorer ? (
                <ProvenanceTag
                  kind="simulated"
                  label="Simulated scorer"
                  title="Suggested scores come from a stand-in that scores answer length, not quality."
                />
              ) : (
                <ProvenanceTag
                  kind="automated"
                  label={check.scorerModel ? `Model · ${check.scorerModel}` : 'Model'}
                  title="Suggested scores came from a model call made by the background worker."
                />
              )}
              {simulatedEvidence ? (
                <ProvenanceTag
                  kind="simulated"
                  label="Simulated lookups"
                  title="GitHub and NVD were not contacted. Evidence rows are made up from the claims."
                />
              ) : (
                <ProvenanceTag
                  kind="automated"
                  label="Live lookups"
                  title="GitHub and the NVD were queried for each claim."
                />
              )}
              {check.checkedAt && (
                <span title={formatDateTime(check.checkedAt)}>
                  Checked {formatRelative(check.checkedAt)}
                </span>
              )}
              {check.costMicros !== null && (
                <span className="tabular-nums">
                  · est. {formatCostMicros(check.costMicros)} (
                  {check.inputTokens.toLocaleString('en-US')} in,{' '}
                  {check.outputTokens.toLocaleString('en-US')} out)
                </span>
              )}
            </div>

            {check.status === 'PENDING' && (
              <p className="rounded-md border border-dashed border-ink-300 px-3 py-2.5 text-sm text-ink-600">
                Checking… Results appear here when the worker finishes. Reload in a minute.
              </p>
            )}

            {check.status === 'FAILED' && (
              <Alert tone="warning">
                Suggested scores could not be made
                {check.error ? `: ${check.error}` : '.'} The evidence and flags below are still
                current. Use Check again to retry.
              </Alert>
            )}

            <section aria-label="Integrity flags">
              <SectionHeading>Flags</SectionHeading>
              {flags.length === 0 ? (
                <p className="text-sm text-ink-500">
                  {check.status === 'PENDING' ? 'Not checked yet.' : 'No flags raised.'}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {flags.map((flag, index) => {
                    const other = flag.relatedReference ? related[flag.relatedReference] : null;
                    return (
                      <li
                        key={`${flag.code}-${index}`}
                        className={clsx(
                          'rounded-md border px-3 py-2',
                          SEVERITY_CLASS[flag.severity],
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={SEVERITY_TONE[flag.severity]}>
                            {SEVERITY_LABEL[flag.severity]}
                          </Badge>
                          <span className="text-sm font-semibold">{FLAG_LABELS[flag.code]}</span>
                        </div>
                        {flag.detail && (
                          <p className="mt-1 text-sm break-anywhere">{flag.detail}</p>
                        )}
                        {flag.relatedReference && (
                          <p className="mt-1 text-xs">
                            Compare with{' '}
                            {other ? (
                              <Link
                                className="font-semibold underline hover:no-underline"
                                href={`/candidates/${other.candidateId}`}
                              >
                                <span className="font-mono">{flag.relatedReference}</span> (
                                {other.candidateName})
                              </Link>
                            ) : (
                              <span className="font-mono font-semibold">
                                {flag.relatedReference}
                              </span>
                            )}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {flags.length > 0 && (
                <p className="mt-1.5 text-xs text-ink-500">
                  A flag is a reason to look harder, not a verdict. Each one has an innocent
                  explanation too.
                </p>
              )}
            </section>

            <section aria-label="Evidence">
              <SectionHeading>Evidence</SectionHeading>
              {evidence.length === 0 ? (
                <p className="text-sm text-ink-500">
                  No GitHub accounts, repositories, CVEs or bar admissions were cited.
                </p>
              ) : (
                <ul className="divide-y divide-ink-100 rounded-md border border-ink-200">
                  {evidence.map((row, index) => {
                    const status = EVIDENCE_STATUS[row.status];
                    return (
                      <li
                        key={`${row.kind}-${row.subject}-${index}`}
                        className="grid gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[8.5rem_minmax(0,1fr)]"
                      >
                        <div className="flex flex-wrap items-center gap-2 sm:block">
                          <Badge tone={status.tone}>
                            <span aria-hidden="true" className="mr-1">
                              {status.glyph}
                            </span>
                            {status.label}
                          </Badge>
                          <span className="text-xs text-ink-500 sm:mt-1 sm:block">
                            {EVIDENCE_KIND_LABEL[row.kind]}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-ink-900 break-anywhere">
                            {row.url ? (
                              <a
                                className="text-accent-700 hover:underline"
                                href={row.url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {row.subject}
                                <span className="sr-only"> (opens in a new tab)</span>
                              </a>
                            ) : (
                              row.subject
                            )}
                          </p>
                          {row.detail && (
                            <p className="mt-0.5 text-xs text-ink-600 break-anywhere">
                              {row.detail}
                            </p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section aria-label="Suggested scores">
              <SectionHeading>Suggested scores</SectionHeading>
              {check.suggestionsWithheld ? (
                <p className="rounded-md border border-accent-100 bg-accent-50 px-3 py-2.5 text-sm text-accent-700">
                  Suggested scores are hidden until you submit your review, so they don&rsquo;t
                  anchor your scoring.
                </p>
              ) : scores.length === 0 ? (
                <p className="text-sm text-ink-500">
                  {check.status === 'FAILED' ? 'None, see above.' : 'No suggestions yet.'}
                </p>
              ) : (
                <SuggestedScores
                  scores={scores}
                  total={check.suggestedTotal}
                  maxTotal={check.maxTotal}
                  pass={check.suggestedPass}
                  passThreshold={passThreshold}
                  summary={check.summary}
                />
              )}
            </section>
          </>
        )}
      </div>
    </details>
  );
}

function SuggestedScores({
  scores,
  total,
  maxTotal,
  pass,
  passThreshold,
  summary,
}: {
  scores: ReturnType<typeof readSuggestedScores>;
  total: number | null;
  maxTotal: number | null;
  pass: boolean | null;
  passThreshold: number;
  summary: string;
}) {
  const gateMissed = scores.some(
    (score) => score.isGating && score.score < Math.ceil(score.maxScore / 2),
  );
  return (
    <div className="space-y-2">
      {summary && <p className="text-sm text-ink-700">{summary}</p>}
      <ul className="divide-y divide-ink-100 rounded-md border border-ink-200">
        {scores.map((score) => (
          <li
            key={score.key}
            className="grid gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[12rem_minmax(0,1fr)]"
          >
            <div>
              <p className="text-sm font-medium text-ink-900">{score.label}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-500">
                <span className="font-semibold tabular-nums text-ink-800">
                  {score.score} / {score.maxScore}
                </span>
                {score.weight !== 1 && <span>× {score.weight}</span>}
                {score.isGating && (
                  <Badge tone="neutral" title="Needs at least half marks for a pass.">
                    gating
                  </Badge>
                )}
              </p>
            </div>
            <div className="min-w-0 space-y-1">
              {score.rationale && (
                <p className="text-sm text-ink-700 break-anywhere">{score.rationale}</p>
              )}
              {score.quote ? (
                <blockquote
                  className={clsx(
                    'border-l-2 pl-2 text-xs italic break-anywhere',
                    score.quoteFound
                      ? 'border-ink-300 text-ink-600'
                      : 'border-amber-400 text-amber-900',
                  )}
                >
                  &ldquo;{score.quote}&rdquo;
                  {!score.quoteFound && (
                    <span className="mt-0.5 block font-semibold not-italic">
                      This quote is not in the candidate&rsquo;s answer. Read the answer yourself.
                    </span>
                  )}
                </blockquote>
              ) : (
                <p className="text-xs text-ink-400">No supporting quote.</p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {total !== null && maxTotal !== null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md bg-ink-50 px-3 py-2 text-sm">
          <span className="text-ink-700">
            Suggested weighted total{' '}
            <strong className="tabular-nums text-ink-900">
              {total} of {maxTotal}
            </strong>
            <span className="text-ink-500"> · pass threshold {passThreshold}</span>
          </span>
          <ProportionBar value={total} max={maxTotal} tone="neutral" className="w-24" />
          {pass !== null && (
            <Badge
              tone="neutral"
              title="What the suggested scores add up to. The reviewer's own scores are what count."
            >
              {pass ? 'Suggests a pass' : 'Suggests below the bar'}
            </Badge>
          )}
          {pass === false && total >= passThreshold && gateMissed && (
            <span className="text-xs text-ink-500">A gating criterion is under half marks.</span>
          )}
        </div>
      )}
    </div>
  );
}
