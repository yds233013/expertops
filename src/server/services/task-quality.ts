import { type GoldDecision, type Prisma, type TaskVerdict } from '@prisma/client';
import { z } from 'zod';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, invalidState, notFound } from '@/lib/errors';
import { formatReference, parseReferenceSequence } from '@/lib/ids';
import {
  checkerSchema,
  decideVerdict,
  structuralFindings,
  taskSpecSchema,
  VERDICT_GUIDANCE,
  VERDICTS_NEEDING_ATTENTION,
  type Finding,
  type TaskSpec,
} from '@/server/domain/task-checks';
import { type Actor, recordActivity, SYSTEM_ACTOR } from './activity';
import { raiseAttention, resolveIfPresent } from './attention';
import { enqueueJob } from './jobs';
import {
  estimateCostMicros,
  solverFor,
  taskCheckConfig,
  type SolverAttempt,
  type TaskCheckConfig,
  type TaskSolver,
} from './task-solver';

/**
 * Task quality: automated checks on submitted evaluation tasks, calibration of
 * the people who review them, and a scorecard per expert.
 *
 * Every output here is evidence for a person. A check verdict does not approve
 * or reject anything; a calibration score does not stop anyone reviewing; a
 * scorecard does not feed matching. Each is shown beside the decision it
 * informs, with the attempts and answers it was computed from.
 */

// ---------------------------------------------------------------------------
// Running a check
// ---------------------------------------------------------------------------

export type RunTaskCheckResult =
  | { skipped: string }
  | { checkId: string; verdict: TaskVerdict | null; status: 'COMPLETED' | 'INCONCLUSIVE' };

/** A stored attempt. The reply is trimmed further; tokens stay for the estimate. */
function storedAttempt(attempt: SolverAttempt, index: number) {
  return {
    index,
    answer: attempt.answer,
    passed: attempt.passed,
    error: attempt.error ?? null,
    reply: attempt.reply.slice(-1500),
    inputTokens: attempt.inputTokens,
    outputTokens: attempt.outputTokens,
    durationMs: attempt.durationMs,
  };
}

/**
 * Check one submission. Called by the worker; safe to call twice.
 *
 * Re-reads the submission, and skips when it has no task, or when a newer
 * revision has been submitted since (that revision gets its own check). The
 * result is written with an upsert keyed on the submission, so a duplicate
 * delivery replaces rather than duplicates.
 */
export async function runTaskCheck(
  db: Db,
  submissionId: string,
  options: { solver?: TaskSolver; config?: TaskCheckConfig; now?: Date } = {},
): Promise<RunTaskCheckResult> {
  const config = options.config ?? taskCheckConfig();
  const solver = options.solver ?? solverFor(config);
  const at = options.now ?? clockNow();

  const submission = await db.workSubmission.findUnique({
    where: { id: submissionId },
    include: { workItem: { include: { expert: true } } },
  });
  if (!submission) return { skipped: 'submission no longer exists' };
  if (submission.taskSpec === null) return { skipped: 'submission has no task' };
  if (submission.workItem.currentRevision !== submission.revision) {
    return { skipped: `revision ${submission.revision} has been superseded` };
  }
  if (submission.workItem.status === 'CANCELLED') return { skipped: 'work item was cancelled' };

  const parsed = taskSpecSchema.safeParse(submission.taskSpec);
  let findings: Finding[];
  let spec: TaskSpec | null = null;
  if (parsed.success) {
    spec = parsed.data;
    findings = structuralFindings(spec);
  } else {
    findings = [
      {
        code: 'CHECKER_UNUSABLE',
        blocking: true,
        message: 'The stored task does not match the task format.',
      },
    ];
  }

  // Blocking findings mean any attempt would prove nothing. Do not pay for it.
  const attempts: SolverAttempt[] =
    spec && !findings.some((finding) => finding.blocking)
      ? await Promise.all(
          Array.from({ length: config.attempts }, (_, index) =>
            solver.attempt(spec, { seed: submission.id, index }),
          ),
        )
      : [];

  const result = decideVerdict(findings, attempts, config.attempts);
  const inputTokens = attempts.reduce((sum, attempt) => sum + attempt.inputTokens, 0);
  const outputTokens = attempts.reduce((sum, attempt) => sum + attempt.outputTokens, 0);
  const status = result.verdict === null ? 'INCONCLUSIVE' : 'COMPLETED';

  const data = {
    workItemId: submission.workItemId,
    expertId: submission.workItem.expertId,
    projectId: submission.workItem.projectId,
    provider: solver.provider,
    model: solver.model,
    status,
    verdict: result.verdict,
    requestedAttempts: config.attempts,
    validAttempts: result.validAttempts,
    passes: result.passes,
    findings: findings as unknown as Prisma.InputJsonValue,
    attempts: attempts.map(storedAttempt) as unknown as Prisma.InputJsonValue,
    inconclusiveReason: result.inconclusiveReason ?? null,
    inputTokens,
    outputTokens,
    estimatedCostMicros:
      solver.provider === 'simulated'
        ? 0
        : estimateCostMicros(solver.model, inputTokens, outputTokens),
    checkedAt: at,
  } as const;

  const check = await db.taskCheck.upsert({
    where: { submissionId },
    create: { submissionId, ...data },
    update: data,
  });

  const { workItem } = submission;
  await recordActivity(db, {
    actor: SYSTEM_ACTOR,
    entityType: 'work_item',
    entityId: workItem.id,
    projectId: workItem.projectId,
    expertId: workItem.expertId,
    action: 'work.task_checked',
    summary:
      result.verdict === null
        ? `Task check on ${workItem.reference} was inconclusive`
        : `Task check on ${workItem.reference}: ${result.verdict.replace(/_/g, ' ').toLowerCase()} (${result.passes}/${result.validAttempts} solved, ${solver.provider})`,
    metadata: {
      submissionId,
      revision: submission.revision,
      verdict: result.verdict,
      passes: result.passes,
      validAttempts: result.validAttempts,
      provider: solver.provider,
      model: solver.model,
    },
  });

  const dedupeKey = `work:task_check:${workItem.id}`;
  if (result.verdict && VERDICTS_NEEDING_ATTENTION.includes(result.verdict)) {
    await raiseAttention(
      db,
      {
        dedupeKey,
        category: 'work.task_quality',
        severity: result.verdict === 'TOO_EASY' ? 'LOW' : 'MEDIUM',
        title: `${workItem.reference} from ${workItem.expert.fullName}: ${result.verdict.replace(/_/g, ' ').toLowerCase()}`,
        blocker:
          findings.find((finding) => finding.blocking)?.message ?? VERDICT_GUIDANCE[result.verdict],
        impact: 'Approving it would pay for a task that cannot measure what the project needs.',
        nextAction: 'Open the work item, read the check, and request a revision if it holds up.',
        projectId: workItem.projectId,
        expertId: workItem.expertId,
        workItemId: workItem.id,
        metadata: { submissionId, verdict: result.verdict },
      },
      { now: at },
    );
  } else {
    // A fixed revision clears the flag the previous one raised.
    await resolveIfPresent(db, dedupeKey, 'A later check found no task-quality problem.', {
      now: at,
    });
  }

  return { checkId: check.id, verdict: result.verdict, status };
}

/** HUMAN ACTION. Queue a fresh check of the latest submission on a work item. */
export async function requestTaskRecheck(db: Db, actor: Actor, workItemId: string) {
  const workItem = await db.workItem.findUnique({
    where: { id: workItemId },
    include: { submissions: { orderBy: { revision: 'desc' }, take: 1 } },
  });
  if (!workItem) throw notFound('Work item not found.');
  const latest = workItem.submissions[0];
  if (!latest) throw invalidState('Nothing has been submitted yet.');
  if (latest.taskSpec === null)
    throw invalidState('The latest submission is not an evaluation task.');

  const at = clockNow();
  const job = await enqueueJob(db, {
    type: 'work.check_task',
    payload: { submissionId: latest.id },
    priority: 40,
    // A minute bucket: a double click queues one re-run, a later click another.
    dedupeKey: `work.check_task:${latest.id}:rerun:${Math.floor(at.getTime() / 60_000)}`,
  });

  await recordActivity(db, {
    actor,
    entityType: 'work_item',
    entityId: workItem.id,
    projectId: workItem.projectId,
    expertId: workItem.expertId,
    action: 'work.task_recheck_requested',
    summary: `${actor.label} asked for ${workItem.reference} to be checked again`,
    metadata: { submissionId: latest.id },
  });

  return { jobId: job.job?.id ?? null, submissionId: latest.id };
}

export async function listTaskChecks(
  db: Db,
  options: {
    verdict?: TaskVerdict;
    inconclusive?: boolean;
    projectId?: string;
    limit?: number;
  } = {},
) {
  return db.taskCheck.findMany({
    where: {
      ...(options.verdict ? { verdict: options.verdict } : {}),
      ...(options.inconclusive ? { status: 'INCONCLUSIVE' as const } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
    },
    include: {
      workItem: { select: { id: true, reference: true, title: true, status: true } },
      expert: { select: { id: true, fullName: true, reference: true } },
      project: { select: { id: true, code: true, title: true } },
      submission: { select: { revision: true } },
    },
    orderBy: { checkedAt: 'desc' },
    take: Math.min(options.limit ?? 50, 200),
  });
}

export async function taskCheckCounts(db: Db, options: { since?: Date } = {}) {
  const grouped = await db.taskCheck.groupBy({
    by: ['verdict', 'status'],
    where: options.since ? { checkedAt: { gte: options.since } } : {},
    _count: { _all: true },
  });
  const counts: Record<TaskVerdict | 'INCONCLUSIVE', number> = {
    BROKEN_SPEC: 0,
    ANSWER_LEAK: 0,
    TOO_EASY: 0,
    DISCRIMINATING: 0,
    UNSOLVED: 0,
    INCONCLUSIVE: 0,
  };
  for (const row of grouped) {
    if (row.status === 'INCONCLUSIVE' || row.verdict === null)
      counts.INCONCLUSIVE += row._count._all;
    else counts[row.verdict] += row._count._all;
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return { ...counts, total };
}

// ---------------------------------------------------------------------------
// Gold tasks and reviewer calibration
// ---------------------------------------------------------------------------

export const GOLD_REFERENCE_PREFIX = 'GLD';

/** A reviewer needs this many gold answers before a calibration score means anything. */
export const MIN_GOLD_ANSWERS = 5;
/** Below this share of correct gold answers, a reviewer is flagged for a calibration session. */
export const CALIBRATION_THRESHOLD = 0.8;

async function nextGoldReference(db: Db): Promise<string> {
  const rows = await db.goldTask.findMany({
    where: { reference: { startsWith: `${GOLD_REFERENCE_PREFIX}-` } },
    select: { reference: true },
  });
  let highest = 0;
  for (const row of rows) {
    const sequence = parseReferenceSequence(GOLD_REFERENCE_PREFIX, row.reference);
    if (sequence > highest) highest = sequence;
  }
  return formatReference(GOLD_REFERENCE_PREFIX, highest + 1);
}

export const createGoldTaskSchema = z.object({
  title: z.string().trim().min(3).max(200),
  domainId: z.string().min(1).nullable().optional(),
  prompt: z.string().trim().min(1).max(20_000),
  referenceAnswer: z.string().trim().min(1).max(2_000),
  checker: checkerSchema,
  expectedDecision: z.enum(['APPROVE', 'REVISE']),
  rationale: z.string().trim().min(10, 'Say why that is the right decision.').max(4_000),
});

export type CreateGoldTaskInput = z.infer<typeof createGoldTaskSchema>;

/** HUMAN ACTION. Add a task whose correct review decision is known. */
export async function createGoldTask(db: Db, actor: Actor, input: CreateGoldTaskInput) {
  const data = createGoldTaskSchema.parse(input);
  if (data.domainId) {
    const domain = await db.domain.findUnique({ where: { id: data.domainId } });
    if (!domain) throw badRequest('That domain does not exist.');
  }
  const goldTask = await db.goldTask.create({
    data: {
      reference: await nextGoldReference(db),
      title: data.title,
      domainId: data.domainId ?? null,
      prompt: data.prompt,
      referenceAnswer: data.referenceAnswer,
      checker: data.checker as Prisma.InputJsonValue,
      expectedDecision: data.expectedDecision,
      rationale: data.rationale,
      createdById: actor.userId ?? null,
    },
  });
  await recordActivity(db, {
    actor,
    entityType: 'gold_task',
    entityId: goldTask.id,
    action: 'quality.gold_task_created',
    summary: `${actor.label} added gold task ${goldTask.reference}`,
    metadata: { expectedDecision: goldTask.expectedDecision },
  });
  return goldTask;
}

/** HUMAN ACTION. Take a gold task out of circulation. Answers already given stay. */
export async function retireGoldTask(db: Db, actor: Actor, goldTaskId: string) {
  const goldTask = await db.goldTask.findUnique({ where: { id: goldTaskId } });
  if (!goldTask) throw notFound('Gold task not found.');
  if (goldTask.retiredAt) return goldTask;
  const updated = await db.goldTask.update({
    where: { id: goldTaskId },
    data: { retiredAt: clockNow() },
  });
  await recordActivity(db, {
    actor,
    entityType: 'gold_task',
    entityId: goldTaskId,
    action: 'quality.gold_task_retired',
    summary: `${actor.label} retired gold task ${goldTask.reference}`,
  });
  return updated;
}

export async function listGoldTasks(db: Db) {
  return db.goldTask.findMany({
    include: {
      domain: { select: { name: true } },
      answers: { select: { correct: true } },
    },
    orderBy: [{ retiredAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
    take: 200,
  });
}

/**
 * The next gold task this reviewer has not answered.
 *
 * Returned without its expected decision or rationale: those are revealed only
 * by answering, so a reviewer cannot read the key first.
 */
export async function nextGoldTaskFor(db: Db, reviewerId: string) {
  const goldTask = await db.goldTask.findFirst({
    where: { retiredAt: null, answers: { none: { reviewerId } } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      reference: true,
      title: true,
      prompt: true,
      referenceAnswer: true,
      checker: true,
      domain: { select: { name: true } },
    },
  });
  const remaining = await db.goldTask.count({
    where: { retiredAt: null, answers: { none: { reviewerId } } },
  });
  return { goldTask, remaining };
}

export const answerGoldTaskSchema = z.object({
  decision: z.enum(['APPROVE', 'REVISE']),
  note: z.string().max(2_000).optional(),
});

/**
 * HUMAN ACTION. A reviewer answers one gold task. Write-once.
 *
 * The answer is marked right or wrong against the expected decision, and the
 * rationale comes back with it so the reviewer learns from a miss straight
 * away.
 */
export async function answerGoldTask(
  db: Db,
  actor: Actor,
  input: { goldTaskId: string; decision: GoldDecision; note?: string },
) {
  if (actor.type !== 'OPERATOR' || !actor.userId) {
    throw badRequest('Only a signed-in reviewer can answer a gold task.');
  }
  const body = answerGoldTaskSchema.parse(input);
  const goldTask = await db.goldTask.findUnique({ where: { id: input.goldTaskId } });
  if (!goldTask) throw notFound('Gold task not found.');
  if (goldTask.retiredAt) throw invalidState('That gold task has been retired.');

  const existing = await db.goldAnswer.findUnique({
    where: { goldTaskId_reviewerId: { goldTaskId: goldTask.id, reviewerId: actor.userId } },
  });
  if (existing) throw invalidState('You have already answered this gold task.');

  const correct = body.decision === goldTask.expectedDecision;
  const answer = await db.goldAnswer.create({
    data: {
      goldTaskId: goldTask.id,
      reviewerId: actor.userId,
      decision: body.decision,
      note: body.note?.trim() ?? '',
      correct,
    },
  });

  await recordActivity(db, {
    actor,
    entityType: 'gold_task',
    entityId: goldTask.id,
    action: 'quality.gold_answered',
    summary: `${actor.label} answered gold task ${goldTask.reference} (${correct ? 'matched' : 'did not match'} the key)`,
    metadata: { decision: body.decision, correct },
  });

  return {
    answer,
    correct,
    expectedDecision: goldTask.expectedDecision,
    rationale: goldTask.rationale,
  };
}

export interface ReviewerCalibration {
  reviewerId: string;
  name: string;
  answered: number;
  correct: number;
  /** Null until the reviewer has `MIN_GOLD_ANSWERS` answers. */
  accuracy: number | null;
  needsCalibration: boolean;
}

export async function reviewerCalibration(db: Db): Promise<ReviewerCalibration[]> {
  const reviewers = await db.user.findMany({
    where: { isActive: true, role: { in: ['OPERATOR', 'ADMIN'] } },
    select: { id: true, name: true, goldAnswers: { select: { correct: true } } },
    orderBy: { name: 'asc' },
  });
  return reviewers.map((reviewer) => {
    const answered = reviewer.goldAnswers.length;
    const correct = reviewer.goldAnswers.filter((answer) => answer.correct).length;
    const accuracy = answered >= MIN_GOLD_ANSWERS ? correct / answered : null;
    return {
      reviewerId: reviewer.id,
      name: reviewer.name,
      answered,
      correct,
      accuracy,
      needsCalibration: accuracy !== null && accuracy < CALIBRATION_THRESHOLD,
    };
  });
}

// ---------------------------------------------------------------------------
// Expert scorecards
// ---------------------------------------------------------------------------

/** Below this many reviewed items, a scorecard shows counts but no rates. */
export const MIN_SCORECARD_ITEMS = 5;

export interface ExpertScorecard {
  expertId: string;
  fullName: string;
  reference: string;
  /** Items with at least one decided review. */
  reviewed: number;
  approved: number;
  /** Approved without ever being sent back. */
  approvedFirstTime: number;
  revisionRequests: number;
  /** Items with a due date whose first submission arrived. */
  dueItemsSubmitted: number;
  onTime: number;
  checked: number;
  /** Checks that found a broken, leaking or too-easy task. */
  flaggedChecks: number;
  /** Rates are null until `MIN_SCORECARD_ITEMS`; a small sample is not a pattern. */
  firstTimeApprovalRate: number | null;
  onTimeRate: number | null;
  flaggedCheckRate: number | null;
  sufficient: boolean;
}

function rate(numerator: number, denominator: number, sufficient: boolean): number | null {
  if (!sufficient || denominator === 0) return null;
  return numerator / denominator;
}

/**
 * Per-expert delivery patterns.
 *
 * Read-only and computed on request. It is shown to operators beside the work
 * it summarises and is deliberately **not** an input to matching or to any
 * automated decision: a review still judges one submission, and this only
 * makes a pattern across many of them visible to a person.
 */
export async function expertScorecards(
  db: Db,
  options: { expertIds?: string[] } = {},
): Promise<ExpertScorecard[]> {
  const experts = await db.expert.findMany({
    where: {
      ...(options.expertIds ? { id: { in: options.expertIds } } : {}),
      workItems: { some: {} },
    },
    select: {
      id: true,
      fullName: true,
      reference: true,
      workItems: {
        where: { status: { not: 'CANCELLED' } },
        select: {
          status: true,
          dueAt: true,
          reviews: { select: { state: true } },
          submissions: { select: { revision: true, submittedAt: true } },
        },
      },
      taskChecks: { select: { verdict: true, status: true } },
    },
    orderBy: { fullName: 'asc' },
    take: 500,
  });

  return experts.map((expert) => {
    let reviewed = 0;
    let approved = 0;
    let approvedFirstTime = 0;
    let revisionRequests = 0;
    let dueItemsSubmitted = 0;
    let onTime = 0;

    for (const item of expert.workItems) {
      const decided = item.reviews.filter((review) => review.state !== 'PENDING');
      const sentBack = decided.filter((review) => review.state === 'REVISION_REQUESTED').length;
      revisionRequests += sentBack;
      if (decided.length > 0) reviewed += 1;
      if (item.status === 'APPROVED') {
        approved += 1;
        if (sentBack === 0) approvedFirstTime += 1;
      }
      const first = item.submissions.find((submission) => submission.revision === 1);
      if (item.dueAt && first) {
        dueItemsSubmitted += 1;
        if (first.submittedAt.getTime() <= item.dueAt.getTime()) onTime += 1;
      }
    }

    const completed = expert.taskChecks.filter((check) => check.status === 'COMPLETED');
    const flaggedChecks = completed.filter(
      (check) => check.verdict !== null && VERDICTS_NEEDING_ATTENTION.includes(check.verdict),
    ).length;
    const sufficient = reviewed >= MIN_SCORECARD_ITEMS;

    return {
      expertId: expert.id,
      fullName: expert.fullName,
      reference: expert.reference,
      reviewed,
      approved,
      approvedFirstTime,
      revisionRequests,
      dueItemsSubmitted,
      onTime,
      checked: completed.length,
      flaggedChecks,
      firstTimeApprovalRate: rate(approvedFirstTime, approved, sufficient),
      onTimeRate: rate(onTime, dueItemsSubmitted, sufficient),
      flaggedCheckRate: rate(flaggedChecks, completed.length, sufficient && completed.length > 0),
      sufficient,
    };
  });
}
