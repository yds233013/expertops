import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatRelative } from '@/lib/time';
import { requireOperator } from '@/server/http/context';
import { assertCapability, roleHasCapability } from '@/server/auth/permissions';
import {
  CALIBRATION_THRESHOLD,
  expertScorecards,
  listGoldTasks,
  listTaskChecks,
  MIN_GOLD_ANSWERS,
  MIN_SCORECARD_ITEMS,
  nextGoldTaskFor,
  reviewerCalibration,
  taskCheckCounts,
} from '@/server/services/task-quality';
import {
  describeChecker,
  isTaskVerdict,
  parseChecker,
  VERDICT_GUIDANCE,
  VERDICT_LABEL,
  VERDICT_ORDER,
  VERDICT_TONE,
} from '@/lib/task-quality-format';
import { ActionButton } from '@/components/action-button';
import { GoldCalibrate } from '@/components/gold-calibrate';
import { GoldTaskForm } from '@/components/gold-task-form';
import { SolvedCount, SolverTag, VerdictBadge } from '@/components/task-quality';
import {
  Badge,
  Card,
  CellPrimary,
  EmptyState,
  PageHeader,
  ProvenanceTag,
  RateValue,
  StatTile,
  TableShell,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Task quality: whether submitted evaluation tasks can measure anything, and
 * whether the people reviewing them agree with a known key.
 *
 * Everything on this page is evidence for a person. A verdict does not approve
 * a task, a calibration score does not stop anyone reviewing, and a scorecard
 * does not feed matching.
 */
export default async function QualityPage({
  searchParams,
}: {
  searchParams: Promise<{ verdict?: string }>;
}) {
  const operator = await requireOperator();
  assertCapability(operator, 'quality:read');
  const params = await searchParams;
  const verdict = isTaskVerdict(params.verdict) ? params.verdict : undefined;
  const inconclusive = params.verdict === 'INCONCLUSIVE';

  const canWrite = roleHasCapability(operator.role, 'quality:write');
  const canCalibrate = roleHasCapability(operator.role, 'quality:calibrate');

  const [counts, checks, calibration, scorecards, next, goldTasks, myAnswers, domains] =
    await Promise.all([
      taskCheckCounts(prisma),
      listTaskChecks(prisma, { verdict, inconclusive, limit: 50 }),
      reviewerCalibration(prisma),
      expertScorecards(prisma),
      canCalibrate ? nextGoldTaskFor(prisma, operator.id) : null,
      canWrite ? listGoldTasks(prisma) : [],
      canWrite
        ? prisma.goldAnswer.findMany({
            where: { reviewerId: operator.id },
            select: { goldTaskId: true },
          })
        : [],
      canWrite
        ? prisma.domain.findMany({
            where: { isActive: true },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
          })
        : [],
    ]);

  const answeredByMe = new Set(myAnswers.map((answer) => answer.goldTaskId));
  const flagged = counts.BROKEN_SPEC + counts.ANSWER_LEAK + counts.TOO_EASY;
  const anySimulated = checks.some((check) => check.provider === 'simulated');
  const dueCalibration = calibration.filter((row) => row.needsCalibration).length;
  const activeGold = goldTasks.filter((task) => !task.retiredAt).length;

  const filterHref = (value?: string) =>
    value ? `/quality?verdict=${value}#checks` : '/quality#checks';

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Delivery"
        title="Task quality"
        description="Automated checks on submitted evaluation tasks, reviewer calibration against known answers, and a delivery pattern per expert. Every figure here is advice for a person; none of it approves, rejects or pays for anything."
        meta={anySimulated ? <SolverTag provider="simulated" /> : undefined}
      />

      <nav className="section-nav" aria-label="Sections on this page">
        <a href="#checks">
          Checks <span className="section-nav-count">{counts.total}</span>
        </a>
        <a href="#scorecards">
          Expert scorecards <span className="section-nav-count">{scorecards.length}</span>
        </a>
        <a href="#calibration">
          Calibration
          {dueCalibration > 0 && <span className="section-nav-count">{dueCalibration} due</span>}
        </a>
        {canWrite && (
          <a href="#gold">
            Gold tasks <span className="section-nav-count">{activeGold}</span>
          </a>
        )}
      </nav>

      <section aria-labelledby="verdicts-heading" className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="verdicts-heading" className="section-title">
            Verdicts across all checks
          </h2>
          <p className="text-xs text-ink-500">
            {counts.total === 0
              ? 'No checks yet'
              : `${flagged} of ${counts.total - counts.INCONCLUSIVE} conclusive checks flagged`}
            {counts.INCONCLUSIVE > 0 && ` · ${counts.INCONCLUSIVE} inconclusive`}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {VERDICT_ORDER.map((value) => {
            const tone = VERDICT_TONE[value];
            const count = counts[value];
            return (
              <StatTile
                key={value}
                label={VERDICT_LABEL[value]}
                value={count}
                href={filterHref(value)}
                tone={tone}
                hint={
                  count === 0
                    ? undefined
                    : tone === 'danger'
                      ? 'fix before approving'
                      : tone === 'warning'
                        ? 'take a look'
                        : undefined
                }
                sub={VERDICT_GUIDANCE[value]}
              />
            );
          })}
        </div>
      </section>

      <Card
        title={
          <span id="checks" className="inline-block scroll-mt-28">
            Recent checks{verdict ? ` · ${VERDICT_LABEL[verdict]}` : ''} ({checks.length})
          </span>
        }
        description="The latest check on each submitted task. Open the work item to read the attempts and re-run it."
        actions={<ProvenanceTag kind="automated" />}
        flush
      >
        <div className="border-b border-ink-100 px-4 py-2.5">
          <nav className="segmented" aria-label="Filter checks by verdict">
            <Link
              href={filterHref()}
              aria-current={!verdict && !inconclusive ? 'page' : undefined}
              className="segmented-item"
            >
              All <span className="tabular-nums text-ink-400">{counts.total}</span>
            </Link>
            {VERDICT_ORDER.map((value) => (
              <Link
                key={value}
                href={filterHref(value)}
                aria-current={verdict === value ? 'page' : undefined}
                className="segmented-item"
              >
                {VERDICT_LABEL[value]}{' '}
                <span className="tabular-nums text-ink-400">{counts[value]}</span>
              </Link>
            ))}
            {counts.INCONCLUSIVE > 0 && (
              <Link
                href={filterHref('INCONCLUSIVE')}
                aria-current={inconclusive ? 'page' : undefined}
                className="segmented-item"
              >
                Inconclusive{' '}
                <span className="tabular-nums text-ink-400">{counts.INCONCLUSIVE}</span>
              </Link>
            )}
          </nav>
        </div>
        {checks.length === 0 ? (
          <EmptyState
            title={
              inconclusive
                ? 'No inconclusive checks'
                : verdict
                  ? `No checks with the verdict “${VERDICT_LABEL[verdict]}”`
                  : 'No task checks yet'
            }
            hint={
              verdict
                ? 'Try another verdict, or show all checks.'
                : 'A check runs when an expert submits work marked as an evaluation task.'
            }
            action={
              verdict ? (
                <Link className="btn btn-secondary btn-sm" href={filterHref()}>
                  Show all checks
                </Link>
              ) : undefined
            }
          />
        ) : (
          <TableShell label="Recent task checks">
            <thead>
              <tr>
                <th scope="col">Work item</th>
                <th scope="col">Expert</th>
                <th scope="col">Project</th>
                <th scope="col">Verdict</th>
                <th scope="col">Solved</th>
                <th scope="col">Solver</th>
                <th scope="col">Checked</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((check) => (
                <tr key={check.id}>
                  <td className="max-w-[18rem]">
                    <CellPrimary
                      href={`/work?status=${check.workItem.status}#${check.workItem.reference}`}
                      meta={`${check.workItem.reference} · revision ${check.submission.revision}`}
                    >
                      {check.workItem.title}
                    </CellPrimary>
                  </td>
                  <td className="whitespace-nowrap">
                    <Link
                      className="text-accent-700 hover:underline"
                      href={`/experts/${check.expert.id}`}
                    >
                      {check.expert.fullName}
                    </Link>
                  </td>
                  <td>
                    <Link
                      className="font-mono text-xs text-ink-700 hover:text-accent-700 hover:underline"
                      href={`/projects/${check.project.id}`}
                      title={check.project.title}
                    >
                      {check.project.code}
                    </Link>
                  </td>
                  <td>
                    <VerdictBadge verdict={check.verdict} status={check.status} />
                  </td>
                  <td>
                    <SolvedCount
                      passes={check.passes}
                      valid={check.validAttempts}
                      verdict={check.verdict}
                    />
                  </td>
                  <td>
                    <SolverTag provider={check.provider} model={check.model} />
                  </td>
                  <td className="whitespace-nowrap text-xs text-ink-600">
                    {formatRelative(check.checkedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Card
        title={
          <span id="scorecards" className="inline-block scroll-mt-28">
            Expert scorecards
          </span>
        }
        description={`Shown to operators beside the work they summarise, and never an input to matching or any automated decision. Rates appear once an expert has ${MIN_SCORECARD_ITEMS} reviewed items.`}
        flush
      >
        {scorecards.length === 0 ? (
          <EmptyState
            title="No experts with work yet"
            hint="A scorecard appears once an expert has a work item."
          />
        ) : (
          <TableShell label="Expert scorecards">
            <thead>
              <tr>
                <th scope="col">Expert</th>
                <th scope="col" className="text-right">
                  Reviewed
                </th>
                <th scope="col">Approved first time</th>
                <th scope="col">Submitted on time</th>
                <th scope="col">Checks flagged</th>
              </tr>
            </thead>
            <tbody>
              {scorecards.map((card) => (
                <tr key={card.expertId}>
                  <td>
                    <CellPrimary href={`/experts/${card.expertId}`} meta={card.reference}>
                      {card.fullName}
                    </CellPrimary>
                  </td>
                  <td className="text-right tabular-nums">{card.reviewed}</td>
                  {card.sufficient ? (
                    <>
                      <td>
                        <RateValue
                          numerator={card.approvedFirstTime}
                          denominator={card.approved}
                          empty="Nothing approved yet"
                        />
                      </td>
                      <td>
                        <RateValue
                          numerator={card.onTime}
                          denominator={card.dueItemsSubmitted}
                          empty="No due dates"
                        />
                      </td>
                      <td>
                        <RateValue
                          numerator={card.flaggedChecks}
                          denominator={card.checked}
                          empty="No checked tasks"
                        />
                      </td>
                    </>
                  ) : (
                    <td colSpan={3} className="text-xs text-ink-400">
                      Not enough reviewed work ({card.reviewed} of {MIN_SCORECARD_ITEMS})
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <div
        id="calibration"
        className="grid scroll-mt-24 grid-cols-1 gap-5 lg:grid-cols-2 lg:items-start"
      >
        <Card
          title="Calibrate"
          description="Judge a task whose right decision is already known. The key is shown after you answer."
        >
          {!canCalibrate ? (
            <EmptyState
              title="Calibration is for reviewers"
              hint="Your role can read calibration results but not answer gold tasks."
            />
          ) : next?.goldTask ? (
            <GoldCalibrate
              key={next.goldTask.id}
              remaining={next.remaining}
              task={{
                id: next.goldTask.id,
                reference: next.goldTask.reference,
                title: next.goldTask.title,
                prompt: next.goldTask.prompt,
                referenceAnswer: next.goldTask.referenceAnswer,
                checkerText: describeChecker(parseChecker(next.goldTask.checker)),
                domain: next.goldTask.domain?.name ?? null,
              }}
            />
          ) : (
            <EmptyState
              glyph="✓"
              title="You have answered every gold task"
              hint={
                canWrite
                  ? 'Add another gold task below to keep calibrating.'
                  : 'New gold tasks appear here when an operator adds them.'
              }
            />
          )}
        </Card>

        <Card
          title="Reviewer calibration"
          description={`Share of gold tasks answered the way the key says. Shown after ${MIN_GOLD_ANSWERS} answers; below ${percent(CALIBRATION_THRESHOLD)} a calibration session is due. It never stops anyone reviewing.`}
          flush
        >
          {calibration.length === 0 ? (
            <EmptyState title="No active reviewers" />
          ) : (
            <TableShell label="Reviewer calibration">
              <thead>
                <tr>
                  <th scope="col">Reviewer</th>
                  <th scope="col" className="text-right">
                    Answered
                  </th>
                  <th scope="col">Accuracy</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {calibration.map((row) => (
                  <tr key={row.reviewerId}>
                    <td className="whitespace-nowrap">
                      <span className="cell-primary">
                        {row.name}
                        {row.reviewerId === operator.id && (
                          <span className="ml-1 font-normal text-ink-500">(you)</span>
                        )}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{row.answered}</td>
                    <td>
                      {row.accuracy === null ? (
                        <span className="text-xs text-ink-400">
                          Needs {MIN_GOLD_ANSWERS} answers ({row.answered} so far)
                        </span>
                      ) : (
                        <RateValue numerator={row.correct} denominator={row.answered} />
                      )}
                    </td>
                    <td>
                      {row.needsCalibration ? (
                        <Badge tone="warning">Calibration due</Badge>
                      ) : row.accuracy !== null ? (
                        <Badge tone="success">Calibrated</Badge>
                      ) : (
                        <Badge tone="muted">Too few answers</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>
      </div>

      {canWrite && (
        <div
          id="gold"
          className="grid scroll-mt-24 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] xl:items-start"
        >
          <Card
            title="Add a gold task"
            description="A task with a known right review decision. Gold tasks never reach an expert and never produce a payment."
          >
            <GoldTaskForm domains={domains} />
          </Card>

          <Card
            title={`Gold tasks (${goldTasks.length})`}
            description="The expected decision stays hidden until you have answered a task yourself."
            flush
          >
            {goldTasks.length === 0 ? (
              <EmptyState
                title="No gold tasks yet"
                hint="Add one with a clear right answer, such as a task whose prompt gives the answer away."
              />
            ) : (
              <TableShell label="Gold tasks">
                <thead>
                  <tr>
                    <th scope="col">Gold task</th>
                    <th scope="col">Expected</th>
                    <th scope="col">Answers</th>
                    <th scope="col" className="row-actions">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {goldTasks.map((task) => {
                    const answered = task.answers.length;
                    const matched = task.answers.filter((answer) => answer.correct).length;
                    const revealed = answeredByMe.has(task.id);
                    return (
                      <tr key={task.id} className={task.retiredAt ? 'opacity-70' : undefined}>
                        <td className="max-w-[16rem]">
                          <CellPrimary
                            meta={[
                              task.reference,
                              task.domain?.name,
                              describeChecker(parseChecker(task.checker)),
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          >
                            {task.title}
                          </CellPrimary>
                        </td>
                        <td className="whitespace-nowrap">
                          {revealed ? (
                            <Badge tone="neutral">
                              {task.expectedDecision === 'APPROVE' ? 'Approve' : 'Revise'}
                            </Badge>
                          ) : (
                            <span
                              className="text-xs text-ink-400"
                              title="Answer it in Calibrate to see the key."
                            >
                              Hidden
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap">
                          {answered === 0 ? (
                            <span className="text-xs text-ink-400">No answers</span>
                          ) : (
                            <span className="text-xs text-ink-700">
                              <span className="tabular-nums">{matched}</span> of{' '}
                              <span className="tabular-nums">{answered}</span> matched the key
                            </span>
                          )}
                        </td>
                        <td className="row-actions">
                          {task.retiredAt ? (
                            <Badge tone="muted" title={`Retired ${formatRelative(task.retiredAt)}`}>
                              Retired
                            </Badge>
                          ) : (
                            <ActionButton
                              url={`/api/quality/gold-tasks/${task.id}`}
                              body={{ action: 'retire' }}
                              label="Retire"
                              pendingLabel="Retiring…"
                              variant="danger"
                              confirm="No reviewer will be asked this again. Answers already given stay."
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableShell>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
