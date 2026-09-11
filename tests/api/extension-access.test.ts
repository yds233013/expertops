import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import { buildRequest, callRoute, operatorToken } from '../helpers/api';
import {
  actorFor,
  makeConfirmedAssignment,
  makeDomain,
  makeExpert,
  makeOperator,
  makeProject,
  makeRubricVersion,
} from '../helpers/factories';

import { GET as listAttention } from '@/app/api/attention/route';
import { POST as attentionItemAction } from '@/app/api/attention/[itemId]/route';
import { GET as listCandidates, POST as createCandidateRoute } from '@/app/api/candidates/route';
import { POST as candidateAction } from '@/app/api/candidates/[candidateId]/route';
import { POST as duplicateAction } from '@/app/api/duplicates/[flagId]/route';
import { GET as listRubrics, POST as rubricAction } from '@/app/api/rubrics/route';
import { POST as screeningAction } from '@/app/api/screenings/[screeningId]/route';
import { POST as outreachAction } from '@/app/api/outreach-batches/[batchId]/route';
import { POST as createBatchRoute } from '@/app/api/outreach-batches/route';
import { POST as workReviewRoute } from '@/app/api/work-items/[workItemId]/route';
import { POST as paymentBatchAction } from '@/app/api/payment-batches/[batchId]/route';
import { POST as importRoute } from '@/app/api/experts/import/route';
import { GET as exportRoute } from '@/app/api/experts/export/route';

import { createCandidate } from '@/server/services/candidates';
import {
  createBatch as createOutreachBatch,
  submitBatchForApproval,
} from '@/server/services/outreach';
import { createWorkItem, submitWork } from '@/server/services/work';
import {
  createBatch as createPaymentBatch,
  draftPaymentFromApprovedWork,
  submitBatchForApproval as submitPaymentBatch,
} from '@/server/services/payments';
import { reviewWork } from '@/server/services/work';

/**
 * Authorisation on the extension endpoints.
 *
 * The point of these is not that each endpoint works, which the service tests
 * cover, but that the capability boundary is real: a viewer cannot write, an
 * operator cannot reach the admin-only approvals, and the strong decisions are
 * genuinely gated.
 */
describe('viewers can read but never write', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('lets a viewer read the attention queue', async () => {
    const viewer = await makeOperator({ role: 'VIEWER' });
    const token = await operatorToken(viewer);

    const result = await callRoute(
      listAttention,
      buildRequest('GET', '/api/attention', { operatorToken: token }),
    );
    expect(result.status).toBe(200);
    expect(result.body.counts).toBeDefined();
  });

  it('refuses a viewer creating a candidate', async () => {
    const viewer = await makeOperator({ role: 'VIEWER' });
    const token = await operatorToken(viewer);

    const result = await callRoute(
      createCandidateRoute,
      buildRequest('POST', '/api/candidates', {
        operatorToken: token,
        body: { fullName: 'Blocked', email: 'blocked@example.test' },
      }),
    );
    expect(result.status).toBe(403);
    expect(result.body.error.message).toContain('candidate:write');
    expect(await prisma.candidate.count()).toBe(0);
  });

  it('refuses a viewer managing an attention item', async () => {
    const viewer = await makeOperator({ role: 'VIEWER' });
    const operator = await makeOperator();
    const token = await operatorToken(viewer);

    const { raiseAttention } = await import('@/server/services/attention');
    const { item } = await raiseAttention(prisma, {
      dedupeKey: 'k',
      category: 'c',
      title: 't',
      blocker: 'b',
      impact: 'i',
      nextAction: 'n',
    });

    const result = await callRoute(
      attentionItemAction,
      buildRequest('POST', `/api/attention/${item.id}`, {
        operatorToken: token,
        body: { action: 'assign', ownerId: operator.id },
      }),
      { itemId: item.id },
    );
    expect(result.status).toBe(403);
  });

  it('refuses a viewer running an import', async () => {
    const viewer = await makeOperator({ role: 'VIEWER' });
    const token = await operatorToken(viewer);

    const result = await callRoute(
      importRoute,
      buildRequest('POST', '/api/experts/import', {
        operatorToken: token,
        body: { csv: 'full_name,email\nA,a@example.test\n', commit: true },
      }),
    );
    expect(result.status).toBe(403);
  });

  it('lets a viewer export the expert list', async () => {
    const viewer = await makeOperator({ role: 'VIEWER' });
    const token = await operatorToken(viewer);
    await makeExpert();

    const result = await callRoute(
      exportRoute,
      buildRequest('GET', '/api/experts/export', { operatorToken: token }),
    );
    expect(result.status).toBe(200);
    expect(result.response.headers.get('content-type')).toContain('text/csv');
  });
});

describe('admin-only decisions are genuinely admin-only', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('refuses an operator publishing a rubric version', async () => {
    const operator = await makeOperator({ role: 'OPERATOR' });
    const token = await operatorToken(operator);
    const domain = await makeDomain();
    const draft = await makeRubricVersion(domain.id, { publish: false });

    const result = await callRoute(
      rubricAction,
      buildRequest('POST', '/api/rubrics', {
        operatorToken: token,
        body: { action: 'publish', versionId: draft.id },
      }),
    );
    expect(result.status).toBe(403);
    expect(result.body.error.message).toContain('rubric:publish');

    // Still a draft.
    const stored = await prisma.screeningRubricVersion.findUniqueOrThrow({
      where: { id: draft.id },
    });
    expect(stored.status).toBe('DRAFT');
  });

  it('lets an operator draft a rubric version but not publish it', async () => {
    const operator = await makeOperator({ role: 'OPERATOR' });
    const token = await operatorToken(operator);
    const domain = await makeDomain();

    const created = await callRoute(
      rubricAction,
      buildRequest('POST', '/api/rubrics', {
        operatorToken: token,
        body: {
          action: 'create_template',
          name: 'Operator template',
          domainId: domain.id,
        },
      }),
    );
    expect(created.status).toBe(201);

    const drafted = await callRoute(
      rubricAction,
      buildRequest('POST', '/api/rubrics', {
        operatorToken: token,
        body: {
          action: 'draft_version',
          templateId: created.body.template.id,
          criteria: [{ key: 'depth', label: 'Depth' }],
        },
      }),
    );
    expect(drafted.status).toBe(201);
  });

  it('refuses an operator resolving a reviewer conflict', async () => {
    const operator = await makeOperator({ role: 'OPERATOR' });
    const token = await operatorToken(operator);

    const result = await callRoute(
      screeningAction,
      buildRequest('POST', '/api/screenings/any/', {
        operatorToken: token,
        body: { action: 'resolve_conflict', resolution: 'APPROVE', note: 'Mine now.' },
      }),
      { screeningId: 'any' },
    );
    expect(result.status).toBe(403);
    expect(result.body.error.message).toContain('screening:resolve_conflict');
  });

  it('refuses an operator approving an outreach batch', async () => {
    const operator = await makeOperator({ role: 'OPERATOR' });
    const token = await operatorToken(operator);
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ status: 'VERIFIED' });

    const batch = await createOutreachBatch(prisma, actorFor(operator), {
      kind: 'PROJECT_INVITATION',
      projectId: project.id,
      items: [{ expertId: expert.id }],
    });
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);

    const result = await callRoute(
      outreachAction,
      buildRequest('POST', `/api/outreach-batches/${batch.id}`, {
        operatorToken: token,
        body: { action: 'decide', approve: true },
      }),
      { batchId: batch.id },
    );
    expect(result.status).toBe(403);
    expect(result.body.error.message).toContain('outreach:approve');

    const stored = await prisma.outreachBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(stored.status).toBe('PENDING_APPROVAL');
  });

  it('refuses an operator dispatching a batch directly', async () => {
    const operator = await makeOperator({ role: 'OPERATOR' });
    const admin = await makeOperator({ role: 'ADMIN' });
    const token = await operatorToken(operator);
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ status: 'VERIFIED' });

    const batch = await createOutreachBatch(prisma, actorFor(operator), {
      kind: 'PROJECT_INVITATION',
      projectId: project.id,
      items: [{ expertId: expert.id }],
    });
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);
    const { decideBatch } = await import('@/server/services/outreach');
    await decideBatch(prisma, actorFor(admin), { batchId: batch.id, approve: true });

    const result = await callRoute(
      outreachAction,
      buildRequest('POST', `/api/outreach-batches/${batch.id}`, {
        operatorToken: token,
        body: { action: 'dispatch' },
      }),
      { batchId: batch.id },
    );
    expect(result.status).toBe(403);
    expect(await prisma.invitation.count()).toBe(0);
  });

  it('refuses an operator approving a payment batch', async () => {
    const operator = await makeOperator({ role: 'OPERATOR', name: 'Sam' });
    const token = await operatorToken(operator);
    const project = await makeProject(operator.id, { status: 'ACTIVE' });
    const expert = await makeExpert({ status: 'VERIFIED' });
    const assignment = await makeConfirmedAssignment(project.id, expert.id);

    const workItem = await createWorkItem(prisma, actorFor(operator), {
      assignmentId: assignment.id,
      title: 'Work',
    });
    await submitWork(
      prisma,
      { type: 'EXPERT', expertId: expert.id, label: expert.fullName },
      { workItemId: workItem.id, content: 'Done.' },
    );
    await reviewWork(prisma, actorFor(operator), { workItemId: workItem.id, approve: true });
    const { item } = await draftPaymentFromApprovedWork(prisma, actorFor(operator), {
      workItemId: workItem.id,
    });
    const { resolveDiscrepancy } = await import('@/server/services/payments');
    await resolveDiscrepancy(prisma, actorFor(operator), {
      paymentItemId: item.id,
      resolution: 'Agreed.',
    }).catch(() => undefined);

    const batch = await createPaymentBatch(prisma, actorFor(operator), {
      periodStart: new Date('2026-05-01'),
      periodEnd: new Date('2026-05-31'),
      itemIds: [item.id],
    });
    await submitPaymentBatch(prisma, actorFor(operator), batch.id);

    const result = await callRoute(
      paymentBatchAction,
      buildRequest('POST', `/api/payment-batches/${batch.id}`, {
        operatorToken: token,
        body: { action: 'approve' },
      }),
      { batchId: batch.id },
    );
    expect(result.status).toBe(403);
    expect(result.body.error.message).toContain('payment:approve');

    const stored = await prisma.paymentBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(stored.status).toBe('PENDING_APPROVAL');
    expect(stored.approvedById).toBeNull();
  });
});

describe('extension endpoints reject anonymous callers', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('requires a session on every new read endpoint', async () => {
    const results = await Promise.all([
      callRoute(listAttention, buildRequest('GET', '/api/attention')),
      callRoute(listCandidates, buildRequest('GET', '/api/candidates')),
      callRoute(listRubrics, buildRequest('GET', '/api/rubrics')),
      callRoute(exportRoute, buildRequest('GET', '/api/experts/export')),
    ]);
    for (const result of results) {
      expect(result.status).toBe(401);
    }
  });

  it('requires a session on every new write endpoint', async () => {
    const results = await Promise.all([
      callRoute(
        createCandidateRoute,
        buildRequest('POST', '/api/candidates', {
          body: { fullName: 'X', email: 'x@example.test' },
        }),
      ),
      callRoute(
        createBatchRoute,
        buildRequest('POST', '/api/outreach-batches', {
          body: { kind: 'REPLACEMENT', items: [{ expertId: 'x' }] },
        }),
      ),
      callRoute(
        importRoute,
        buildRequest('POST', '/api/experts/import', { body: { csv: 'a,b\n1,2\n' } }),
      ),
    ]);
    for (const result of results) {
      expect(result.status).toBe(401);
    }
  });
});

describe('operator workflow through the API', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('creates a candidate and reports a duplicate hold rather than silently merging', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    await makeExpert({ email: 'shared@example.test' });

    const result = await callRoute(
      createCandidateRoute,
      buildRequest('POST', '/api/candidates', {
        operatorToken: token,
        body: { fullName: 'Shared Person', email: 'shared@example.test' },
      }),
    );

    expect(result.status).toBe(201);
    expect(result.body.onHoldForDuplicateReview).toBe(true);
    expect(result.body.duplicateFlags).toHaveLength(1);
    expect(result.body.candidate.stage).toBe('DUPLICATE_HOLD');
  });

  it('resolves a duplicate through the API and requires a note', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    await makeExpert({ email: 'shared@example.test' });
    const { duplicateFlags } = await createCandidate(prisma, actorFor(operator), {
      fullName: 'Shared Person',
      email: 'shared@example.test',
    });
    const flagId = duplicateFlags[0]!.id;

    const missingNote = await callRoute(
      duplicateAction,
      buildRequest('POST', `/api/duplicates/${flagId}`, {
        operatorToken: token,
        body: { samePerson: false, note: '' },
      }),
      { flagId },
    );
    expect(missingNote.status).toBe(400);

    const resolved = await callRoute(
      duplicateAction,
      buildRequest('POST', `/api/duplicates/${flagId}`, {
        operatorToken: token,
        body: { samePerson: false, note: 'Verified as different people.' },
      }),
      { flagId },
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.flag.status).toBe('CONFIRMED_DIFFERENT');
  });

  it('starts a screening and refuses one against an unpublished rubric', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    const domain = await makeDomain();
    const published = await makeRubricVersion(domain.id, { name: 'Published' });
    const draft = await makeRubricVersion(domain.id, { name: 'Draft one', publish: false });
    const { candidate } = await createCandidate(prisma, actorFor(operator), {
      fullName: 'Applicant',
      email: 'applicant@example.test',
    });

    const rejected = await callRoute(
      candidateAction,
      buildRequest('POST', `/api/candidates/${candidate.id}`, {
        operatorToken: token,
        body: { action: 'start_screening', rubricVersionId: draft.id },
      }),
      { candidateId: candidate.id },
    );
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.message).toContain('published rubric version');

    const accepted = await callRoute(
      candidateAction,
      buildRequest('POST', `/api/candidates/${candidate.id}`, {
        operatorToken: token,
        body: { action: 'start_screening', rubricVersionId: published.id },
      }),
      { candidateId: candidate.id },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.screening.reference).toMatch(/^SCR-/);
  });

  it('states at the API boundary that a work review is not a standing judgement', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    const project = await makeProject(operator.id, { status: 'ACTIVE' });
    const expert = await makeExpert({ status: 'VERIFIED' });
    const assignment = await makeConfirmedAssignment(project.id, expert.id);
    const workItem = await createWorkItem(prisma, actorFor(operator), {
      assignmentId: assignment.id,
      title: 'Work',
    });
    await submitWork(
      prisma,
      { type: 'EXPERT', expertId: expert.id, label: expert.fullName },
      { workItemId: workItem.id, content: 'Done.' },
    );

    const result = await callRoute(
      workReviewRoute,
      buildRequest('POST', `/api/work-items/${workItem.id}`, {
        operatorToken: token,
        body: { approve: true, summary: 'Fine.' },
      }),
      { workItemId: workItem.id },
    );
    expect(result.status).toBe(200);
    expect(result.body.affectsExpertRanking).toBe(false);
  });

  it('previews an import without writing, then commits on request', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    const csv =
      'full_name,email,headline,years_experience,hourly_rate,currency,timezone,weekly_capacity_hours,skills,notes\n' +
      'Avery Lindqvist,avery@example.test,Consultant,12,250,USD,UTC,20,Incident Response:5,\n';

    const preview = await callRoute(
      importRoute,
      buildRequest('POST', '/api/experts/import', { operatorToken: token, body: { csv } }),
    );
    expect(preview.status).toBe(200);
    expect(preview.body.mode).toBe('preview');
    expect(preview.body.preview.creatable).toBe(1);
    expect(await prisma.expert.count()).toBe(0);

    const committed = await callRoute(
      importRoute,
      buildRequest('POST', '/api/experts/import', {
        operatorToken: token,
        body: { csv, commit: true },
      }),
    );
    expect(committed.status).toBe(200);
    expect(committed.body.created).toBe(1);
    expect(committed.body.note).toContain('human review decision');
    expect(await prisma.expert.count()).toBe(1);
  });

  it('reports attention counts split by kind', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);

    const { raiseAttention, raiseAutomationFailure } = await import('@/server/services/attention');
    await raiseAttention(prisma, {
      dedupeKey: 'business-1',
      category: 'test',
      title: 'Business blocker',
      blocker: 'b',
      impact: 'i',
      nextAction: 'n',
    });
    await raiseAutomationFailure(prisma, {
      jobId: 'j1',
      jobType: 'outbox.dispatch',
      error: 'boom',
      attempts: 5,
    });

    const result = await callRoute(
      listAttention,
      buildRequest('GET', '/api/attention', { operatorToken: token }),
    );
    expect(result.body.counts.businessBlockers).toBe(1);
    expect(result.body.counts.automationFailures).toBe(1);
    expect(result.body.counts.unassigned).toBe(2);
  });
});
