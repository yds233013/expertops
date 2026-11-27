import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { applyMigrations, truncateAll } from '../helpers/db';
import { buildRequest, callRoute, operatorToken } from '../helpers/api';
import {
  actorFor,
  actorForExpert,
  makeConfirmedAssignment,
  makeExpert,
  makeOperator,
  makeProject,
} from '../helpers/factories';
import { type TaskSpec } from '@/server/domain/task-checks';
import { createWorkItem, reviewWork, submitWork } from '@/server/services/work';
import {
  answerGoldTask,
  createGoldTask,
  expertScorecards,
  MIN_SCORECARD_ITEMS,
  nextGoldTaskFor,
  requestTaskRecheck,
  retireGoldTask,
  reviewerCalibration,
  runTaskCheck,
} from '@/server/services/task-quality';
import {
  type SolverAttempt,
  type TaskCheckConfig,
  type TaskSolver,
} from '@/server/services/task-solver';
import { networkMetrics } from '@/server/services/metrics';
import { HANDLERS } from '@/server/worker/handlers';
import { POST as goldTaskAction } from '@/app/api/quality/gold-tasks/[goldTaskId]/route';
import { POST as createGoldTaskRoute } from '@/app/api/quality/gold-tasks/route';

const config: TaskCheckConfig = {
  provider: 'simulated',
  model: 'stub',
  effort: 'medium',
  attempts: 4,
  timeoutMs: 10_000,
};

/** A solver that answers from a script and counts how often it was asked. */
class ScriptedSolver implements TaskSolver {
  readonly provider = 'simulated' as const;
  readonly model = 'scripted';
  calls = 0;
  constructor(private readonly script: (index: number, spec: TaskSpec) => Partial<SolverAttempt>) {}
  async attempt(spec: TaskSpec, context: { seed: string; index: number }): Promise<SolverAttempt> {
    this.calls += 1;
    const scripted = this.script(context.index, spec);
    const answer = scripted.answer ?? null;
    return {
      answer,
      passed: scripted.passed ?? answer === spec.referenceAnswer,
      error: scripted.error,
      reply: `FINAL: ${answer ?? ''}`,
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 1,
    };
  }
}

const always = (answer: string) => new ScriptedSolver(() => ({ answer }));

const goodTask: TaskSpec = {
  prompt:
    'A contract allows termination on 30 days notice served on the 15th of March. Counting the day of service as day one, on what date does the contract end? Answer as YYYY-MM-DD for the year 2026.',
  referenceAnswer: '2026-04-13',
  checker: { kind: 'EXACT', caseSensitive: false },
};

async function expectAppError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected the call to reject with ${code}`);
}

async function fixture() {
  const operator = await makeOperator({ name: 'Sam Operator' });
  const project = await makeProject(operator.id, { status: 'ACTIVE', seatsRequested: 2 });
  const expert = await makeExpert({ status: 'VERIFIED', fullName: 'Rowan Okafor' });
  const assignment = await makeConfirmedAssignment(project.id, expert.id);
  const workItem = await createWorkItem(prisma, actorFor(operator), {
    assignmentId: assignment.id,
    title: 'Contract-date tasks, batch 1',
  });
  return { operator, project, expert, assignment, workItem, actor: actorFor(operator) };
}

async function submitTask(f: Awaited<ReturnType<typeof fixture>>, taskSpec: unknown = goodTask) {
  return submitWork(prisma, actorForExpert(f.expert), {
    workItemId: f.workItem.id,
    content: 'One task, prompt and key below.',
    taskSpec,
  });
}

describe('task submission', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('stores a valid task and queues exactly one check for it', async () => {
    const f = await fixture();
    const { submission } = await submitTask(f);

    expect(submission.taskSpec).toMatchObject({ referenceAnswer: '2026-04-13' });
    const jobs = await prisma.job.findMany({ where: { type: 'work.check_task' } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({ submissionId: submission.id });
  });

  it('refuses a malformed task without storing a submission', async () => {
    const f = await fixture();
    await expectAppError(
      submitTask(f, { prompt: 'x', referenceAnswer: '', checker: { kind: 'EXACT' } }),
      'BAD_REQUEST',
    );
    expect(await prisma.workSubmission.count()).toBe(0);
  });

  it('queues no check for an ordinary deliverable', async () => {
    const f = await fixture();
    await submitWork(prisma, actorForExpert(f.expert), {
      workItemId: f.workItem.id,
      content: 'A written memo.',
    });
    expect(await prisma.job.count({ where: { type: 'work.check_task' } })).toBe(0);
  });
});

describe('running a task check', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('flags a task the model always solves and raises one attention item', async () => {
    const f = await fixture();
    const { submission } = await submitTask(f);
    const solver = always('2026-04-13');

    const result = await runTaskCheck(prisma, submission.id, { solver, config });

    expect(result).toMatchObject({ verdict: 'TOO_EASY', status: 'COMPLETED' });
    expect(solver.calls).toBe(4);
    const check = await prisma.taskCheck.findUniqueOrThrow({
      where: { submissionId: submission.id },
    });
    expect(check).toMatchObject({
      passes: 4,
      validAttempts: 4,
      inputTokens: 400,
      outputTokens: 200,
    });
    const attention = await prisma.attentionItem.findMany({
      where: { category: 'work.task_quality' },
    });
    expect(attention).toHaveLength(1);
    expect(attention[0]?.status).toBe('OPEN');
  });

  it('is idempotent: a duplicate run replaces the check instead of adding one', async () => {
    const f = await fixture();
    const { submission } = await submitTask(f);
    await runTaskCheck(prisma, submission.id, { solver: always('2026-04-13'), config });
    await runTaskCheck(prisma, submission.id, { solver: always('2026-04-13'), config });

    expect(await prisma.taskCheck.count()).toBe(1);
    expect(await prisma.attentionItem.count({ where: { category: 'work.task_quality' } })).toBe(1);
  });

  it('clears the flag when a revised task discriminates', async () => {
    const f = await fixture();
    const first = await submitTask(f);
    await runTaskCheck(prisma, first.submission.id, { solver: always('2026-04-13'), config });

    await reviewWork(prisma, f.actor, {
      workItemId: f.workItem.id,
      approve: false,
      revisionRequest: 'The model solves this every time. Make it harder.',
    });
    const second = await submitTask(f, {
      ...goodTask,
      prompt: `${goodTask.prompt} Exclude public holidays in England.`,
    });
    const mixed = new ScriptedSolver((index) => ({
      answer: index % 2 === 0 ? '2026-04-13' : '2026-04-14',
    }));
    const result = await runTaskCheck(prisma, second.submission.id, { solver: mixed, config });

    expect(result).toMatchObject({ verdict: 'DISCRIMINATING' });
    const attention = await prisma.attentionItem.findFirstOrThrow({
      where: { category: 'work.task_quality' },
    });
    expect(attention.status).toBe('RESOLVED');
  });

  it('skips a revision that has been superseded', async () => {
    const f = await fixture();
    const first = await submitTask(f);
    await reviewWork(prisma, f.actor, {
      workItemId: f.workItem.id,
      approve: false,
      revisionRequest: 'Tighten the wording.',
    });
    await submitTask(f);

    const result = await runTaskCheck(prisma, first.submission.id, { solver: always('x'), config });
    expect(result).toEqual({ skipped: 'revision 1 has been superseded' });
    expect(await prisma.taskCheck.count()).toBe(0);
  });

  it('spends no attempts on a task whose answer is in the prompt', async () => {
    const f = await fixture();
    const { submission } = await submitTask(f, {
      ...goodTask,
      prompt: `${goodTask.prompt} (It ends on 2026-04-13.)`,
    });
    const solver = always('2026-04-13');

    const result = await runTaskCheck(prisma, submission.id, { solver, config });
    expect(result).toMatchObject({ verdict: 'ANSWER_LEAK' });
    expect(solver.calls).toBe(0);
  });

  it('records an inconclusive check when most attempts fail, without raising attention', async () => {
    const f = await fixture();
    const { submission } = await submitTask(f);
    const flaky = new ScriptedSolver((index) =>
      index === 0 ? { answer: '2026-04-13' } : { error: 'Rate limited by the API.' },
    );

    const result = await runTaskCheck(prisma, submission.id, { solver: flaky, config });
    expect(result).toMatchObject({ verdict: null, status: 'INCONCLUSIVE' });
    const check = await prisma.taskCheck.findUniqueOrThrow({
      where: { submissionId: submission.id },
    });
    expect(check.inconclusiveReason).toMatch(/1 of 4/);
    expect(await prisma.attentionItem.count({ where: { category: 'work.task_quality' } })).toBe(0);
  });

  it('runs through the worker handler with the default simulated solver', async () => {
    const f = await fixture();
    const { submission } = await submitTask(f);

    const output = await HANDLERS['work.check_task'](
      { submissionId: submission.id },
      {
        db: prisma,
        client: prisma,
        now: new Date(),
      },
    );
    expect(output).toHaveProperty('checkId');
    const check = await prisma.taskCheck.findUniqueOrThrow({
      where: { submissionId: submission.id },
    });
    expect(check.provider).toBe('simulated');
    expect(check.estimatedCostMicros).toBe(0);
  });

  it('lets an operator queue a re-run of the latest task only', async () => {
    const f = await fixture();
    await expectAppError(requestTaskRecheck(prisma, f.actor, f.workItem.id), 'INVALID_STATE');
    const { submission } = await submitTask(f);

    const result = await requestTaskRecheck(prisma, f.actor, f.workItem.id);
    expect(result.submissionId).toBe(submission.id);
    expect(await prisma.job.count({ where: { type: 'work.check_task' } })).toBe(2);
  });
});

describe('gold tasks and reviewer calibration', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  async function gold(
    actor: ReturnType<typeof actorFor>,
    expectedDecision: 'APPROVE' | 'REVISE',
    title: string,
  ) {
    return createGoldTask(prisma, actor, {
      title,
      prompt: goodTask.prompt,
      referenceAnswer: expectedDecision === 'APPROVE' ? '2026-04-13' : '2026-04-15',
      checker: { kind: 'EXACT', caseSensitive: false },
      expectedDecision,
      rationale: 'Counting the service day as day one, day 30 is 13 April.',
    });
  }

  it('hides the key until the reviewer answers, then reveals it', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const task = await gold(actor, 'REVISE', 'Off-by-two reference');

    const next = await nextGoldTaskFor(prisma, operator.id);
    expect(next.goldTask?.id).toBe(task.id);
    expect(next.goldTask).not.toHaveProperty('expectedDecision');
    expect(next.goldTask).not.toHaveProperty('rationale');

    const answer = await answerGoldTask(prisma, actor, {
      goldTaskId: task.id,
      decision: 'APPROVE',
    });
    expect(answer).toMatchObject({ correct: false, expectedDecision: 'REVISE' });
    expect(answer.rationale).toMatch(/13 April/);
    expect((await nextGoldTaskFor(prisma, operator.id)).goldTask).toBeNull();
  });

  it('accepts one answer per reviewer and none on a retired task', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const task = await gold(actor, 'APPROVE', 'Sound task');
    await answerGoldTask(prisma, actor, { goldTaskId: task.id, decision: 'APPROVE' });
    await expectAppError(
      answerGoldTask(prisma, actor, { goldTaskId: task.id, decision: 'REVISE' }),
      'INVALID_STATE',
    );

    const other = await makeOperator();
    await retireGoldTask(prisma, actor, task.id);
    await expectAppError(
      answerGoldTask(prisma, actorFor(other), { goldTaskId: task.id, decision: 'APPROVE' }),
      'INVALID_STATE',
    );
  });

  it('scores a reviewer only after five answers and flags one below 80%', async () => {
    const operator = await makeOperator({ name: 'Lee Reviewer' });
    const actor = actorFor(operator);
    for (let index = 0; index < 5; index += 1) {
      const task = await gold(actor, index < 3 ? 'APPROVE' : 'REVISE', `Gold ${index}`);
      await answerGoldTask(prisma, actor, { goldTaskId: task.id, decision: 'APPROVE' });
      const partial = (await reviewerCalibration(prisma)).find(
        (row) => row.reviewerId === operator.id,
      );
      if (index < 4) expect(partial?.accuracy).toBeNull();
    }

    const row = (await reviewerCalibration(prisma)).find(
      (entry) => entry.reviewerId === operator.id,
    );
    expect(row).toMatchObject({ answered: 5, correct: 3, accuracy: 0.6, needsCalibration: true });
  });

  it('keeps the gold key behind operator capabilities at the API', async () => {
    const operator = await makeOperator();
    const viewer = await makeOperator({ role: 'VIEWER' });
    const task = await gold(actorFor(operator), 'APPROVE', 'Sound task');

    const denied = await callRoute(
      goldTaskAction,
      buildRequest('POST', `/api/quality/gold-tasks/${task.id}`, {
        operatorToken: await operatorToken(viewer),
        body: { action: 'answer', decision: 'APPROVE' },
      }),
      { goldTaskId: task.id },
    );
    expect(denied.status).toBe(403);

    const createDenied = await callRoute(
      createGoldTaskRoute,
      buildRequest('POST', '/api/quality/gold-tasks', {
        operatorToken: await operatorToken(viewer),
        body: {},
      }),
    );
    expect(createDenied.status).toBe(403);

    const answered = await callRoute(
      goldTaskAction,
      buildRequest('POST', `/api/quality/gold-tasks/${task.id}`, {
        operatorToken: await operatorToken(operator),
        body: { action: 'answer', decision: 'APPROVE' },
      }),
      { goldTaskId: task.id },
    );
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ correct: true, expectedDecision: 'APPROVE' });
  });
});

describe('expert scorecards', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('withholds rates until enough work has been reviewed', async () => {
    const f = await fixture();
    await submitTask(f);
    await reviewWork(prisma, f.actor, { workItemId: f.workItem.id, approve: true });

    const [card] = await expertScorecards(prisma, { expertIds: [f.expert.id] });
    expect(card).toMatchObject({
      reviewed: 1,
      approved: 1,
      approvedFirstTime: 1,
      sufficient: false,
    });
    expect(card?.firstTimeApprovalRate).toBeNull();
  });

  it('reports first-time approval once the sample is large enough', async () => {
    const f = await fixture();
    for (let index = 0; index < MIN_SCORECARD_ITEMS; index += 1) {
      const item = await createWorkItem(prisma, f.actor, {
        assignmentId: f.assignment.id,
        title: `Task ${index}`,
      });
      await submitWork(prisma, actorForExpert(f.expert), { workItemId: item.id, content: 'Done.' });
      if (index === 0) {
        await reviewWork(prisma, f.actor, {
          workItemId: item.id,
          approve: false,
          revisionRequest: 'Fix it.',
        });
        await submitWork(prisma, actorForExpert(f.expert), {
          workItemId: item.id,
          content: 'Fixed.',
        });
      }
      await reviewWork(prisma, f.actor, { workItemId: item.id, approve: true });
    }

    const [card] = await expertScorecards(prisma, { expertIds: [f.expert.id] });
    expect(card).toMatchObject({
      reviewed: 5,
      approved: 5,
      approvedFirstTime: 4,
      revisionRequests: 1,
      sufficient: true,
    });
    expect(card?.firstTimeApprovalRate).toBeCloseTo(0.8);
  });
});

describe('network metrics', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('returns nulls, never NaN, on an empty network', async () => {
    const metrics = await networkMetrics(prisma, { windowDays: 30 });
    expect(metrics.funnel.total.candidates).toBe(0);
    expect(metrics.funnel.total.qualifiedRate).toBeNull();
    expect(metrics.staffing.fillRate).toBeNull();
    expect(metrics.delivery.costPerApprovedMinor).toBeNull();
    expect(metrics.taskQuality.flaggedRate).toBeNull();
    expect(JSON.stringify(metrics)).not.toMatch(/NaN/);
  });

  it('counts seats, approvals and task verdicts from the rows', async () => {
    const f = await fixture();
    const { submission } = await submitTask(f);
    await runTaskCheck(prisma, submission.id, { solver: always('2026-04-13'), config });
    await reviewWork(prisma, f.actor, { workItemId: f.workItem.id, approve: true });

    const metrics = await networkMetrics(prisma, { windowDays: 90 });
    expect(metrics.staffing).toMatchObject({ seatsRequested: 2, seatsFilled: 1, fillRate: 0.5 });
    expect(metrics.delivery).toMatchObject({
      approved: 1,
      approvedFirstTime: 1,
      firstTimeApprovalRate: 1,
    });
    expect(metrics.taskQuality).toMatchObject({ TOO_EASY: 1, total: 1, flaggedRate: 1 });
    expect(metrics.speed.reviewSample).toBe(1);
  });
});
