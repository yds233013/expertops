import Link from 'next/link';
import type { ReactNode } from 'react';
import { prisma } from '@/lib/db';
import { formatMinor } from '@/lib/decimal';
import { formatDate, formatDateTime } from '@/lib/time';
import { requireOperator } from '@/server/http/context';
import { assertCapability } from '@/server/auth/permissions';
import {
  METRIC_WINDOWS,
  networkMetrics,
  type FunnelRow,
  type MetricWindow,
} from '@/server/services/metrics';
import { VERDICT_LABEL, VERDICT_ORDER } from '@/lib/task-quality-format';
import {
  Card,
  EmptyState,
  formatPercent,
  PageHeader,
  ProportionBar,
  RateValue,
  TableShell,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/** One decimal under ten, whole numbers above: "2.5 days", "14 days". */
function formatDuration(value: number, unit: 'day' | 'hour'): string {
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded.toLocaleString('en-US')} ${unit}${rounded === 1 ? '' : 's'}`;
}

/**
 * A figure with what it was computed from and what it means.
 *
 * The same frame as a stat tile, with two extra lines: the numerator and
 * denominator (or sample size), and the definition in plain words.
 */
function Figure({
  label,
  value,
  basis,
  definition,
}: {
  label: string;
  value: ReactNode;
  basis: ReactNode;
  definition: string;
}) {
  return (
    <div className="card flex flex-col px-4 py-3.5">
      <div className="eyebrow mb-0">{label}</div>
      <div className="mt-1.5 text-[1.75rem] font-semibold leading-none tabular-nums text-ink-900">
        {value}
      </div>
      <p className="mt-1.5 text-xs font-medium text-ink-700">{basis}</p>
      <p className="mt-1 text-xs leading-snug text-ink-400">{definition}</p>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <span className="text-ink-400">{children}</span>;
}

function SectionHeading({ id, title, hint }: { id: string; title: string; hint?: string }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
      <h2 id={id} className="section-title scroll-mt-28">
        {title}
      </h2>
      {hint && <p className="text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

function FunnelStage({
  label,
  count,
  of,
  tone,
}: {
  label: string;
  count: number;
  of: number;
  tone: 'neutral' | 'accent' | 'success';
}) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-3">
      <span className="text-sm text-ink-700">{label}</span>
      <ProportionBar value={count} max={of} tone={tone} className="h-2.5 w-full" />
      <span className="w-24 text-right text-sm tabular-nums text-ink-900">
        <span className="font-semibold">{count}</span>
        {of > 0 && count !== of && (
          <span className="ml-1 text-xs text-ink-500">{formatPercent(count, of)}</span>
        )}
      </span>
    </div>
  );
}

function FunnelTable({
  rows,
  label,
  column,
}: {
  rows: FunnelRow[];
  label: string;
  column: string;
}) {
  if (rows.length === 0) {
    return <EmptyState title={`No candidates by ${column.toLowerCase()} in this window`} />;
  }
  return (
    <TableShell label={label}>
      <thead>
        <tr>
          <th scope="col">{column}</th>
          <th scope="col" className="text-right">
            Candidates
          </th>
          <th scope="col">Screened</th>
          <th scope="col">Qualified</th>
          <th scope="col">Qualified rate</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td className="cell-primary whitespace-nowrap">{row.label}</td>
            <td className="text-right tabular-nums">{row.candidates}</td>
            <td>
              <span className="inline-flex items-center gap-2">
                <ProportionBar value={row.screened} max={row.candidates} className="w-16" />
                <span className="text-xs tabular-nums text-ink-700">{row.screened}</span>
              </span>
            </td>
            <td>
              <span className="inline-flex items-center gap-2">
                <ProportionBar
                  value={row.qualified}
                  max={row.candidates}
                  tone="success"
                  className="w-16"
                />
                <span className="text-xs tabular-nums text-ink-700">{row.qualified}</span>
              </span>
            </td>
            <td>
              <RateValue numerator={row.qualified} denominator={row.candidates} empty="—" />
            </td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}

const VERDICT_FILL: Record<(typeof VERDICT_ORDER)[number] | 'INCONCLUSIVE', string> = {
  BROKEN_SPEC: 'bg-rose-600',
  ANSWER_LEAK: 'bg-rose-400',
  TOO_EASY: 'bg-amber-500',
  DISCRIMINATING: 'bg-emerald-600',
  UNSOLVED: 'bg-ink-400',
  INCONCLUSIVE: 'bg-ink-200',
};

/**
 * The numbers an operator is accountable for, over a window, each with its
 * denominator and its definition. Nothing is cached: the page is the query.
 */
export default async function MetricsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const operator = await requireOperator();
  assertCapability(operator, 'metrics:read');
  const params = await searchParams;
  const requested = Number(params.window);
  const windowDays: MetricWindow = (METRIC_WINDOWS as readonly number[]).includes(requested)
    ? (requested as MetricWindow)
    : 90;

  const metrics = await networkMetrics(prisma, { windowDays });
  const { funnel, speed, staffing, delivery, taskQuality } = metrics;

  const verdictSegments = [
    ...VERDICT_ORDER.map((verdict) => ({
      key: verdict,
      label: VERDICT_LABEL[verdict],
      count: taskQuality[verdict],
    })),
    { key: 'INCONCLUSIVE' as const, label: 'Inconclusive', count: taskQuality.INCONCLUSIVE },
  ];
  const conclusive = taskQuality.total - taskQuality.INCONCLUSIVE;
  const flagged = taskQuality.BROKEN_SPEC + taskQuality.ANSWER_LEAK + taskQuality.TOO_EASY;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Today"
        title="Metrics"
        description={
          <>
            The numbers the network is accountable for, from{' '}
            <strong className="font-semibold text-ink-700">{formatDate(metrics.since)}</strong> to
            today. Every rate shows what it was computed from; definitions sit under each figure.
          </>
        }
        actions={
          <nav className="segmented" aria-label="Time window">
            {METRIC_WINDOWS.map((days) => (
              <Link
                key={days}
                href={`/metrics?window=${days}`}
                aria-current={days === windowDays ? 'page' : undefined}
                className="segmented-item"
              >
                {days === 365 ? '12 months' : `${days} days`}
              </Link>
            ))}
          </nav>
        }
      />

      <nav className="section-nav" aria-label="Sections on this page">
        <a href="#funnel">Funnel</a>
        <a href="#speed">Speed</a>
        <a href="#staffing">Staffing</a>
        <a href="#delivery">Delivery</a>
        <a href="#task-quality">Task quality</a>
      </nav>

      {/* --- Funnel ------------------------------------------------------- */}
      <section aria-labelledby="funnel">
        <SectionHeading
          id="funnel"
          title="Sourcing funnel"
          hint={`Candidates created in the last ${windowDays} days`}
        />
        <div className="space-y-4">
          <Card>
            {funnel.total.candidates === 0 ? (
              <EmptyState
                title="No candidates in this window"
                hint="Try a longer window, or check that applications are arriving."
              />
            ) : (
              <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_14rem] md:items-center">
                <div className="space-y-2.5">
                  <FunnelStage
                    label="Candidates"
                    count={funnel.total.candidates}
                    of={funnel.total.candidates}
                    tone="neutral"
                  />
                  <FunnelStage
                    label="Screened"
                    count={funnel.total.screened}
                    of={funnel.total.candidates}
                    tone="accent"
                  />
                  <FunnelStage
                    label="Qualified"
                    count={funnel.total.qualified}
                    of={funnel.total.candidates}
                    tone="success"
                  />
                </div>
                <div className="border-t border-ink-100 pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-0">
                  <div className="eyebrow mb-0">Qualified rate</div>
                  <div className="mt-1.5">
                    <RateValue
                      size="lg"
                      numerator={funnel.total.qualified}
                      denominator={funnel.total.candidates}
                    />
                  </div>
                  <p className="mt-1.5 text-xs leading-snug text-ink-400">
                    Candidates now qualified, of all created in the window. Screened means invited
                    to a screening or past it. {funnel.total.rejected} rejected.
                  </p>
                </div>
              </div>
            )}
          </Card>

          {funnel.total.candidates > 0 && (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Card title="By source channel" flush>
                <FunnelTable
                  rows={funnel.byChannel}
                  label="Funnel by source channel"
                  column="Channel"
                />
              </Card>
              <Card
                title="By domain"
                description="The domain of the candidate’s first application."
                flush
              >
                <FunnelTable rows={funnel.byDomain} label="Funnel by domain" column="Domain" />
              </Card>
            </div>
          )}
        </div>
      </section>

      {/* --- Speed -------------------------------------------------------- */}
      <section aria-labelledby="speed">
        <SectionHeading
          id="speed"
          title="Speed"
          hint="Medians, so one slow case does not skew them"
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Figure
            label="Days to qualify"
            value={
              speed.medianDaysToQualify === null ? (
                <Empty>—</Empty>
              ) : (
                formatDuration(speed.medianDaysToQualify, 'day')
              )
            }
            basis={
              speed.qualifiedSample === 0
                ? 'No candidate qualified in this window'
                : `n = ${speed.qualifiedSample} qualified candidate${speed.qualifiedSample === 1 ? '' : 's'}`
            }
            definition="From the candidate record being created to their first qualification decision."
          />
          <Figure
            label="Review turnaround"
            value={
              speed.medianReviewHours === null ? (
                <Empty>—</Empty>
              ) : (
                formatDuration(speed.medianReviewHours, 'hour')
              )
            }
            basis={
              speed.reviewSample === 0
                ? 'No submission was reviewed in this window'
                : `n = ${speed.reviewSample} reviewed submission${speed.reviewSample === 1 ? '' : 's'}`
            }
            definition="From an expert submitting work to the first decided review of it."
          />
          <Figure
            label="Approval to payment export"
            value={
              speed.medianDaysApprovalToExport === null ? (
                <Empty>—</Empty>
              ) : (
                formatDuration(speed.medianDaysApprovalToExport, 'day')
              )
            }
            basis={
              speed.payoutSample === 0
                ? 'No approved work has been exported yet'
                : `n = ${speed.payoutSample} exported item${speed.payoutSample === 1 ? '' : 's'}`
            }
            definition="From work being approved to its payment batch being exported. Exported is not paid."
          />
        </div>
      </section>

      {/* --- Staffing ----------------------------------------------------- */}
      <section aria-labelledby="staffing">
        <SectionHeading id="staffing" title="Staffing" />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Figure
            label="Fill rate"
            value={formatPercent(staffing.seatsFilled, staffing.seatsRequested) ?? <Empty>—</Empty>}
            basis={
              staffing.seatsRequested === 0
                ? 'No open project is asking for seats'
                : `${staffing.seatsFilled} of ${staffing.seatsRequested} seats filled across ${staffing.openProjects} open project${staffing.openProjects === 1 ? '' : 's'}`
            }
            definition="Seats filled over seats requested, on projects that are matching, inviting, staffing or active. Today, not over the window."
          />
          <Figure
            label="Dropout rate"
            value={formatPercent(staffing.released, staffing.confirmed) ?? <Empty>—</Empty>}
            basis={
              staffing.confirmed === 0
                ? 'No seat was confirmed in this window'
                : `${staffing.released} of ${staffing.confirmed} confirmed seats released`
            }
            definition="Seats confirmed in the window that were later released before the work completed."
          />
        </div>
      </section>

      {/* --- Delivery ----------------------------------------------------- */}
      <section aria-labelledby="delivery">
        <SectionHeading id="delivery" title="Delivery" />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Figure
            label="Approved work items"
            value={delivery.approved}
            basis={`Approved in the last ${windowDays} days`}
            definition="Work items approved in the window, counted by approval date. Cancelled items are left out."
          />
          <Figure
            label="First-time approval"
            value={formatPercent(delivery.approvedFirstTime, delivery.approved) ?? <Empty>—</Empty>}
            basis={
              delivery.approved === 0
                ? 'Nothing approved in this window'
                : `${delivery.approvedFirstTime} of ${delivery.approved} approved without a revision request`
            }
            definition="Approved items that were never sent back, of all approved in the window."
          />
          <Figure
            label="Cost per approved task"
            value={
              delivery.costPerApprovedMinor === null ? (
                <Empty>—</Empty>
              ) : (
                formatMinor(delivery.costPerApprovedMinor, delivery.currency)
              )
            }
            basis={
              delivery.paidItems === 0
                ? 'No approved item is in a batch yet'
                : `${formatMinor(delivery.paidMinor, delivery.currency)} over ${delivery.paidItems} batched or exported item${delivery.paidItems === 1 ? '' : 's'}${delivery.otherCurrencyItems > 0 ? ` (${delivery.otherCurrencyItems} in other currencies left out)` : ''}`
            }
            definition="Payment value of approved items that are in a batch or exported, divided by how many there are. Voided and superseded items are left out."
          />
        </div>
      </section>

      {/* --- Task quality ------------------------------------------------- */}
      <section aria-labelledby="task-quality">
        <SectionHeading
          id="task-quality"
          title="Task quality"
          hint={`Checks run in the last ${windowDays} days`}
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card
            title="Verdict mix"
            actions={
              <Link
                className="text-xs font-semibold text-accent-700 hover:underline"
                href="/quality"
              >
                Open task quality
              </Link>
            }
          >
            {taskQuality.total === 0 ? (
              <EmptyState
                title="No task checks in this window"
                hint="Checks run when an expert submits work marked as an evaluation task."
              />
            ) : (
              <div className="space-y-3">
                <div
                  className="flex h-3 w-full overflow-hidden rounded-full bg-ink-100"
                  role="img"
                  aria-label={verdictSegments
                    .filter((segment) => segment.count > 0)
                    .map((segment) => `${segment.label} ${segment.count}`)
                    .join(', ')}
                >
                  {verdictSegments
                    .filter((segment) => segment.count > 0)
                    .map((segment) => (
                      <div
                        key={segment.key}
                        className={`${VERDICT_FILL[segment.key]} h-full border-r border-white last:border-r-0`}
                        style={{ width: `${(segment.count / taskQuality.total) * 100}%` }}
                        title={`${segment.label}: ${segment.count}`}
                      />
                    ))}
                </div>
                <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
                  {verdictSegments.map((segment) => (
                    <li key={segment.key} className="flex items-center gap-2 text-xs">
                      <span
                        aria-hidden="true"
                        className={`h-2.5 w-2.5 shrink-0 rounded-sm ${VERDICT_FILL[segment.key]}`}
                      />
                      <span className="text-ink-700">{segment.label}</span>
                      <span className="ml-auto tabular-nums text-ink-900">
                        {segment.count}
                        <span className="ml-1 text-ink-400">
                          {formatPercent(segment.count, taskQuality.total)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-ink-400">
                  {taskQuality.total} check{taskQuality.total === 1 ? '' : 's'}. Shares are of all
                  checks, inconclusive included.
                </p>
              </div>
            )}
          </Card>
          <Figure
            label="Flagged rate"
            value={formatPercent(flagged, conclusive) ?? <Empty>—</Empty>}
            basis={
              conclusive === 0
                ? 'No conclusive check in this window'
                : `${flagged} of ${conclusive} conclusive checks flagged`
            }
            definition="Checks that found a broken spec, a leaked answer or a task the model solved every time, of checks that reached a verdict."
          />
        </div>
      </section>

      <p className="text-xs text-ink-400">
        Generated {formatDateTime(metrics.generatedAt)} from live records. Nothing on this page is
        cached or stored.
      </p>
    </div>
  );
}
