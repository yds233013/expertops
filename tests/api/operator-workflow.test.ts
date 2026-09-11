import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import { buildRequest, callRoute, operatorToken } from '../helpers/api';
import { makeExpert, makeOperator, makeProject, makeStaffableExpert } from '../helpers/factories';

import { GET as listExperts, POST as createExpert } from '@/app/api/experts/route';
import { GET as getExpert, PATCH as patchExpert } from '@/app/api/experts/[expertId]/route';
import { POST as verifyExpert } from '@/app/api/experts/[expertId]/verify/route';
import { GET as listProjects, POST as createProject } from '@/app/api/projects/route';
import { POST as setProjectStatus } from '@/app/api/projects/[projectId]/status/route';
import { POST as runMatch, GET as getMatch } from '@/app/api/projects/[projectId]/match/route';
import { POST as createInvite } from '@/app/api/projects/[projectId]/invitations/route';
import { POST as withdrawInvite } from '@/app/api/invitations/[invitationId]/withdraw/route';
import { POST as proposeSeat } from '@/app/api/projects/[projectId]/assignments/route';
import { POST as confirmSeat } from '@/app/api/assignments/[assignmentId]/confirm/route';
import { GET as listOutbox } from '@/app/api/outbox/route';
import { GET as listActivity } from '@/app/api/activity/route';
import { GET as listJobs } from '@/app/api/jobs/route';
import { POST as retryJobRoute } from '@/app/api/jobs/[jobId]/retry/route';
import { GET as verificationQueue } from '@/app/api/onboarding/queue/route';

describe('operator API: experts', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('creates an expert with skills and returns a reference', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);

    const result = await callRoute(
      createExpert,
      buildRequest('POST', '/api/experts', {
        operatorToken: token,
        body: {
          fullName: 'Avery Lindqvist',
          email: 'avery.lindqvist@example.test',
          headline: 'Principal Consultant — payments platforms',
          yearsExperience: 12,
          hourlyRateCents: 24_000,
          timezone: 'Europe/London',
          weeklyCapacityHours: 20,
          skills: [{ name: 'Payments Infrastructure', proficiency: 5, yearsUsed: 9 }],
        },
      }),
    );

    expect(result.status).toBe(201);
    expect(result.body.expert.reference).toMatch(/^EXP-\d{4}$/);
    expect(result.body.expert.status).toBe('PROSPECT');
    expect(await prisma.expertSkill.count()).toBe(1);
  });

  it('rejects a duplicate email with 409', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    const body = {
      fullName: 'Avery Lindqvist',
      email: 'duplicate@example.test',
      headline: 'Consultant',
    };

    await callRoute(
      createExpert,
      buildRequest('POST', '/api/experts', { operatorToken: token, body }),
    );
    const second = await callRoute(
      createExpert,
      buildRequest('POST', '/api/experts', { operatorToken: token, body }),
    );

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
  });

  it('rejects an out-of-range proficiency with 400', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    const result = await callRoute(
      createExpert,
      buildRequest('POST', '/api/experts', {
        operatorToken: token,
        body: {
          fullName: 'Avery Lindqvist',
          email: 'range@example.test',
          headline: 'Consultant',
          skills: [{ name: 'Payments Infrastructure', proficiency: 9 }],
        },
      }),
    );
    expect(result.status).toBe(400);
  });

  it('forbids a viewer from creating an expert but allows reading', async () => {
    const viewer = await makeOperator({ role: 'VIEWER' });
    const token = await operatorToken(viewer);
    await makeExpert({ fullName: 'Visible Expert' });

    const write = await callRoute(
      createExpert,
      buildRequest('POST', '/api/experts', {
        operatorToken: token,
        body: { fullName: 'Blocked', email: 'blocked@example.test', headline: 'x' },
      }),
    );
    expect(write.status).toBe(403);
    expect(write.body.error.message).toContain('expert:write');

    const read = await callRoute(
      listExperts,
      buildRequest('GET', '/api/experts', { operatorToken: token }),
    );
    expect(read.status).toBe(200);
    expect(read.body.experts).toHaveLength(1);
  });

  it('filters the expert list by status and search term', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    await makeExpert({ fullName: 'Verified Person', status: 'VERIFIED' });
    await makeExpert({ fullName: 'Prospect Person', status: 'PROSPECT' });

    const byStatus = await callRoute(
      listExperts,
      buildRequest('GET', '/api/experts', {
        operatorToken: token,
        searchParams: { status: 'VERIFIED' },
      }),
    );
    expect(byStatus.body.experts).toHaveLength(1);
    expect(byStatus.body.experts[0].fullName).toBe('Verified Person');

    const bySearch = await callRoute(
      listExperts,
      buildRequest('GET', '/api/experts', {
        operatorToken: token,
        searchParams: { search: 'prospect' },
      }),
    );
    expect(bySearch.body.experts).toHaveLength(1);
  });

  it('returns 404 for an unknown expert', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    const result = await callRoute(
      getExpert,
      buildRequest('GET', '/api/experts/nope', { operatorToken: token }),
      { expertId: 'nope' },
    );
    expect(result.status).toBe(404);
  });

  it('replaces the skill set on update', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    const expert = await makeExpert({ skills: [{ name: 'Old Skill', proficiency: 3 }] });

    const result = await callRoute(
      patchExpert,
      buildRequest('PATCH', `/api/experts/${expert.id}`, {
        operatorToken: token,
        body: { skills: [{ name: 'New Skill', proficiency: 5 }] },
      }),
      { expertId: expert.id },
    );

    expect(result.status).toBe(200);
    const links = await prisma.expertSkill.findMany({
      where: { expertId: expert.id },
      include: { skill: true },
    });
    expect(links).toHaveLength(1);
    expect(links[0]!.skill.name).toBe('New Skill');
  });
});

describe('operator API: projects, matching and invitations', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  async function signedInOperator(role: 'ADMIN' | 'OPERATOR' | 'VIEWER' = 'OPERATOR') {
    const operator = await makeOperator({ role });
    return { operator, token: await operatorToken(operator) };
  }

  it('creates a project in DRAFT with a generated code', async () => {
    const { token } = await signedInOperator();
    const result = await callRoute(
      createProject,
      buildRequest('POST', '/api/projects', {
        operatorToken: token,
        body: {
          title: 'Card settlement reconciliation review',
          clientName: 'Northwind Logistics',
          seatsRequested: 2,
          minYearsExperience: 6,
          requirements: [
            { skillName: 'Payments Infrastructure', required: true, minProficiency: 3 },
          ],
        },
      }),
    );

    expect(result.status).toBe(201);
    expect(result.body.project.code).toMatch(/^PRJ-\d{4}$/);
    expect(result.body.project.status).toBe('DRAFT');
  });

  it('allocates sequential project codes', async () => {
    const { token } = await signedInOperator();
    const body = {
      title: 'Project',
      clientName: 'Client',
      requirements: [{ skillName: 'Payments Infrastructure', required: true }],
    };
    const first = await callRoute(
      createProject,
      buildRequest('POST', '/api/projects', { operatorToken: token, body }),
    );
    const second = await callRoute(
      createProject,
      buildRequest('POST', '/api/projects', { operatorToken: token, body }),
    );
    expect(first.body.project.code).toBe('PRJ-0001');
    expect(second.body.project.code).toBe('PRJ-0002');
  });

  it('refuses an illegal status transition with 409', async () => {
    const { operator, token } = await signedInOperator();
    const project = await makeProject(operator.id, { status: 'DRAFT' });

    const result = await callRoute(
      setProjectStatus,
      buildRequest('POST', `/api/projects/${project.id}/status`, {
        operatorToken: token,
        body: { status: 'ACTIVE' },
      }),
      { projectId: project.id },
    );

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('INVALID_STATE');
    expect(result.body.error.details.allowed).toEqual(['MATCHING', 'CANCELLED']);
  });

  it('runs matching and returns an explainable ranking', async () => {
    const { operator, token } = await signedInOperator();
    const project = await makeProject(operator.id, {
      status: 'MATCHING',
      requirements: [{ name: 'Payments Infrastructure', required: true, minProficiency: 3 }],
    });
    await makeExpert({
      fullName: 'Strong Candidate',
      yearsExperience: 15,
      skills: [{ name: 'Payments Infrastructure', proficiency: 5 }],
    });
    await makeExpert({
      fullName: 'Missing Skill',
      skills: [{ name: 'Pricing Strategy', proficiency: 5 }],
    });

    const run = await callRoute(
      runMatch,
      buildRequest('POST', `/api/projects/${project.id}/match`, {
        operatorToken: token,
        body: { limit: 10, includeExcluded: true },
      }),
      { projectId: project.id },
    );

    expect(run.status).toBe(201);
    expect(run.body.matchRun.algorithmVersion).toBe('rules-v1');

    const ranked = run.body.matchRun.candidates.filter((c: any) => !c.excluded);
    expect(ranked[0].expert.fullName).toBe('Strong Candidate');
    expect(ranked[0].breakdown).toHaveProperty('requiredSkills');

    const excluded = run.body.matchRun.candidates.find((c: any) => c.excluded);
    expect(excluded.exclusionReason).toContain('Missing required skill');

    const latest = await callRoute(
      getMatch,
      buildRequest('GET', `/api/projects/${project.id}/match`, { operatorToken: token }),
      { projectId: project.id },
    );
    expect(latest.body.matchRun.id).toBe(run.body.matchRun.id);
  });

  it('forbids a viewer from running matching', async () => {
    const owner = await makeOperator();
    const { token } = await signedInOperator('VIEWER');
    const project = await makeProject(owner.id, { status: 'MATCHING' });

    const result = await callRoute(
      runMatch,
      buildRequest('POST', `/api/projects/${project.id}/match`, { operatorToken: token, body: {} }),
      { projectId: project.id },
    );
    expect(result.status).toBe(403);
  });

  it('creates an invitation, queues the send job, and blocks a duplicate', async () => {
    const { operator, token } = await signedInOperator();
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });

    const first = await callRoute(
      createInvite,
      buildRequest('POST', `/api/projects/${project.id}/invitations`, {
        operatorToken: token,
        body: { expertId: expert.id, message: 'Three-week review.', ttlHours: 48 },
      }),
      { projectId: project.id },
    );
    expect(first.status).toBe(201);
    expect(first.body.invitation.status).toBe('DRAFT');
    expect(await prisma.job.count({ where: { type: 'invitation.send' } })).toBe(1);

    const second = await callRoute(
      createInvite,
      buildRequest('POST', `/api/projects/${project.id}/invitations`, {
        operatorToken: token,
        body: { expertId: expert.id },
      }),
      { projectId: project.id },
    );
    expect(second.status).toBe(409);
  });

  it('requires a reason to withdraw an invitation', async () => {
    const { operator, token } = await signedInOperator();
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });
    const created = await callRoute(
      createInvite,
      buildRequest('POST', `/api/projects/${project.id}/invitations`, {
        operatorToken: token,
        body: { expertId: expert.id },
      }),
      { projectId: project.id },
    );
    const invitationId = created.body.invitation.id;

    const blank = await callRoute(
      withdrawInvite,
      buildRequest('POST', `/api/invitations/${invitationId}/withdraw`, {
        operatorToken: token,
        body: { reason: '' },
      }),
      { invitationId },
    );
    expect(blank.status).toBe(400);

    const withReason = await callRoute(
      withdrawInvite,
      buildRequest('POST', `/api/invitations/${invitationId}/withdraw`, {
        operatorToken: token,
        body: { reason: 'Client changed the brief' },
      }),
      { invitationId },
    );
    expect(withReason.status).toBe(200);
    expect(withReason.body.invitation.status).toBe('WITHDRAWN');
  });

  it('lists projects with their requirements', async () => {
    const { operator, token } = await signedInOperator();
    await makeProject(operator.id, { title: 'Listed project' });

    const result = await callRoute(
      listProjects,
      buildRequest('GET', '/api/projects', { operatorToken: token }),
    );
    expect(result.status).toBe(200);
    expect(result.body.projects[0].requirements.length).toBeGreaterThan(0);
  });
});

describe('operator API: verification and staffing', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('verifies a submitted case and queues a simulated email', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    const expert = await makeExpert({ status: 'PENDING_VERIFICATION' });
    await prisma.onboardingCase.create({
      data: { expertId: expert.id, status: 'SUBMITTED', submittedAt: new Date() },
    });

    const queue = await callRoute(
      verificationQueue,
      buildRequest('GET', '/api/onboarding/queue', { operatorToken: token }),
    );
    expect(queue.body.queue).toHaveLength(1);

    const result = await callRoute(
      verifyExpert,
      buildRequest('POST', `/api/experts/${expert.id}/verify`, {
        operatorToken: token,
        body: { approve: true, note: 'Checked the billing reference.' },
      }),
      { expertId: expert.id },
    );

    expect(result.status).toBe(200);
    expect(result.body.onboardingCase.status).toBe('VERIFIED');
    expect((await prisma.expert.findUniqueOrThrow({ where: { id: expert.id } })).status).toBe(
      'VERIFIED',
    );
    expect(await prisma.outboxMessage.count({ where: { template: 'onboarding.verified' } })).toBe(
      1,
    );
  });

  it('forbids a viewer from verifying', async () => {
    const viewer = await makeOperator({ role: 'VIEWER' });
    const token = await operatorToken(viewer);
    const expert = await makeExpert({ status: 'PENDING_VERIFICATION' });
    await prisma.onboardingCase.create({
      data: { expertId: expert.id, status: 'SUBMITTED', submittedAt: new Date() },
    });

    const result = await callRoute(
      verifyExpert,
      buildRequest('POST', `/api/experts/${expert.id}/verify`, {
        operatorToken: token,
        body: { approve: true },
      }),
      { expertId: expert.id },
    );
    expect(result.status).toBe(403);
    expect(result.body.error.message).toContain('onboarding:verify');
  });

  it('proposes and confirms a seat, filling the project', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 1 });
    const expert = await makeStaffableExpert(project.id);

    const proposed = await callRoute(
      proposeSeat,
      buildRequest('POST', `/api/projects/${project.id}/assignments`, {
        operatorToken: token,
        body: { expertId: expert.id, allocationHoursPerWeek: 16 },
      }),
      { projectId: project.id },
    );
    expect(proposed.status).toBe(201);
    expect(proposed.body.assignment.status).toBe('PROPOSED');

    const confirmed = await callRoute(
      confirmSeat,
      buildRequest('POST', `/api/assignments/${proposed.body.assignment.id}/confirm`, {
        operatorToken: token,
      }),
      { assignmentId: proposed.body.assignment.id },
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.seatsFilled).toBe(1);
    expect(confirmed.body.projectBecameActive).toBe(true);
  });

  it('returns 409 with CAPACITY_EXCEEDED when the project is full', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 1 });
    const first = await makeStaffableExpert(project.id);
    const second = await makeStaffableExpert(project.id);

    const proposals = [];
    for (const expert of [first, second]) {
      const proposed = await callRoute(
        proposeSeat,
        buildRequest('POST', `/api/projects/${project.id}/assignments`, {
          operatorToken: token,
          body: { expertId: expert.id, allocationHoursPerWeek: 10 },
        }),
        { projectId: project.id },
      );
      proposals.push(proposed.body.assignment.id);
    }

    await callRoute(
      confirmSeat,
      buildRequest('POST', `/api/assignments/${proposals[0]}/confirm`, { operatorToken: token }),
      { assignmentId: proposals[0]! },
    );

    const overflow = await callRoute(
      confirmSeat,
      buildRequest('POST', `/api/assignments/${proposals[1]}/confirm`, { operatorToken: token }),
      { assignmentId: proposals[1]! },
    );
    expect(overflow.status).toBe(409);
    expect(overflow.body.error.code).toBe('CAPACITY_EXCEEDED');
    expect(overflow.body.error.details.seatsRequested).toBe(1);
  });

  it('refuses to propose an unverified expert with a clear explanation', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING' });
    const expert = await makeExpert({ status: 'PENDING_VERIFICATION' });
    await prisma.invitation.create({
      data: {
        projectId: project.id,
        expertId: expert.id,
        status: 'ACCEPTED',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const result = await callRoute(
      proposeSeat,
      buildRequest('POST', `/api/projects/${project.id}/assignments`, {
        operatorToken: token,
        body: { expertId: expert.id, allocationHoursPerWeek: 10 },
      }),
      { projectId: project.id },
    );

    expect(result.status).toBe(409);
    expect(result.body.error.message).toContain('Only VERIFIED experts can be staffed');
  });
});

describe('operator API: outbox, activity and jobs', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('marks the outbox as simulated in the response payload', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    const result = await callRoute(
      listOutbox,
      buildRequest('GET', '/api/outbox', { operatorToken: token }),
    );
    expect(result.status).toBe(200);
    expect(result.body.simulated).toBe(true);
    expect(result.body.counts).toEqual({ QUEUED: 0, SENT: 0, FAILED: 0 });
  });

  it('returns activity newest first and filters by actor type', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    const project = await makeProject(operator.id);
    await prisma.activityEvent.createMany({
      data: [
        {
          actorType: 'SYSTEM',
          actorLabel: 'worker',
          entityType: 'project',
          entityId: project.id,
          action: 'invitation.expired',
          summary: 'Expired automatically',
          projectId: project.id,
        },
        {
          actorType: 'OPERATOR',
          actorUserId: operator.id,
          actorLabel: operator.name,
          entityType: 'project',
          entityId: project.id,
          action: 'project.created',
          summary: 'Created',
          projectId: project.id,
        },
      ],
    });

    const all = await callRoute(
      listActivity,
      buildRequest('GET', '/api/activity', { operatorToken: token }),
    );
    expect(all.body.events.length).toBeGreaterThanOrEqual(2);

    const systemOnly = await callRoute(
      listActivity,
      buildRequest('GET', '/api/activity', {
        operatorToken: token,
        searchParams: { actorType: 'SYSTEM' },
      }),
    );
    expect(systemOnly.body.events).toHaveLength(1);
    expect(systemOnly.body.events[0].action).toBe('invitation.expired');
  });

  it('lets an admin retry a dead job but not an operator', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const plainOperator = await makeOperator({ role: 'OPERATOR' });
    const adminToken = await operatorToken(admin);
    const operatorTokenValue = await operatorToken(plainOperator);

    const job = await prisma.job.create({
      data: { type: 'outbox.dispatch', status: 'DEAD', attempts: 5, lastError: 'boom' },
    });

    const forbidden = await callRoute(
      retryJobRoute,
      buildRequest('POST', `/api/jobs/${job.id}/retry`, { operatorToken: operatorTokenValue }),
      { jobId: job.id },
    );
    expect(forbidden.status).toBe(403);

    const allowed = await callRoute(
      retryJobRoute,
      buildRequest('POST', `/api/jobs/${job.id}/retry`, { operatorToken: adminToken }),
      { jobId: job.id },
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body.job.status).toBe('PENDING');
    expect(allowed.body.job.attempts).toBe(0);
  });

  it('refuses to retry a job that already succeeded', async () => {
    const admin = await makeOperator({ role: 'ADMIN' });
    const token = await operatorToken(admin);
    const job = await prisma.job.create({
      data: { type: 'outbox.dispatch', status: 'SUCCEEDED', finishedAt: new Date() },
    });

    const result = await callRoute(
      retryJobRoute,
      buildRequest('POST', `/api/jobs/${job.id}/retry`, { operatorToken: token }),
      { jobId: job.id },
    );
    expect(result.status).toBe(403);
  });

  it('reports job counts alongside the list', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);
    await prisma.job.createMany({
      data: [
        { type: 'outbox.dispatch', status: 'PENDING' },
        { type: 'invitation.send', status: 'DEAD' },
      ],
    });

    const result = await callRoute(
      listJobs,
      buildRequest('GET', '/api/jobs', { operatorToken: token }),
    );
    expect(result.body.counts.PENDING).toBe(1);
    expect(result.body.counts.DEAD).toBe(1);
  });
});
