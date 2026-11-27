import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AccessSystem } from '@prisma/client';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import { buildRequest, callRoute, operatorToken } from '../helpers/api';
import {
  actorFor,
  makeConfirmedAssignment,
  makeExpert,
  makeOperator,
  makeProject,
} from '../helpers/factories';
import {
  addAccessResource,
  confirmManualRevoke,
  MAX_ACCESS_ATTEMPTS,
  reconcileAccess,
  retryAccessGrant,
  setGithubUsername,
} from '@/server/services/access';
import { releaseAssignment, completeAssignment } from '@/server/services/staffing';
import {
  SimulatedAccessProvider,
  type AccessOutcome,
  type AccessProvider,
  type AccessProviders,
} from '@/server/integrations/access-providers';
import { POST as accessAction } from '@/app/api/projects/[projectId]/access/route';
import { PUT as portalGithub } from '@/app/api/portal/github/route';

/** A provider that records calls and answers from a script per operation. */
class FakeProvider implements AccessProvider {
  calls: Array<{ op: string; resource: string; subject: string }> = [];
  grantAnswer: () => AccessOutcome = () => ({ kind: 'done', invitationPending: false });
  revokeAnswer: () => AccessOutcome = () => ({ kind: 'done' });
  private readonly simulated: SimulatedAccessProvider;

  constructor(
    readonly system: AccessSystem,
    readonly mode: 'live' | 'simulated' = 'live',
  ) {
    this.simulated = new SimulatedAccessProvider(system);
  }
  resolveSubject(expert: Parameters<AccessProvider['resolveSubject']>[0]) {
    return this.simulated.resolveSubject(expert);
  }
  async grant(resource: { resource: string }, subject: string) {
    this.calls.push({ op: 'grant', resource: resource.resource, subject });
    return this.grantAnswer();
  }
  async revoke(resource: { resource: string }, grant: { subject: string }) {
    this.calls.push({ op: 'revoke', resource: resource.resource, subject: grant.subject });
    return this.revokeAnswer();
  }
  async invitationAccepted() {
    return true;
  }
}

function fakes(mode: 'live' | 'simulated' = 'live') {
  const providers = {
    GITHUB: new FakeProvider('GITHUB', mode),
    SLACK: new FakeProvider('SLACK', mode),
  };
  return providers as typeof providers & AccessProviders;
}

async function setup(options: { githubUsername?: string | null } = {}) {
  const operator = await makeOperator({ role: 'OPERATOR' });
  const actor = actorFor(operator);
  const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 2 });
  const expert = await makeExpert({ status: 'VERIFIED', fullName: 'Ada Example' });
  if (options.githubUsername !== null) {
    await prisma.expert.update({
      where: { id: expert.id },
      data: { githubUsername: options.githubUsername ?? 'ada-dev' },
    });
  }
  const assignment = await makeConfirmedAssignment(project.id, expert.id);
  const repo = await addAccessResource(prisma, actor, {
    projectId: project.id,
    system: 'GITHUB',
    resource: 'https://github.com/Acme/Evals.git',
  });
  const channel = await addAccessResource(prisma, actor, {
    projectId: project.id,
    system: 'SLACK',
    resource: 'C08ABCDEF12',
    label: '#acme-evals',
  });
  return { operator, actor, project, expert, assignment, repo, channel };
}

const grantsOf = (expertId: string) =>
  prisma.accessGrant.findMany({ where: { expertId }, orderBy: { system: 'asc' } });

describe('access follows the seat', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('grants every listed resource to a confirmed, verified expert, once', async () => {
    const ctx = await setup();
    expect(ctx.repo.resource).toBe('acme/evals');
    const providers = fakes();

    const first = await reconcileAccess(prisma, { providers });
    expect(first).toMatchObject({ granted: 2, failed: 0 });
    expect(providers.GITHUB.calls).toEqual([
      { op: 'grant', resource: 'acme/evals', subject: 'ada-dev' },
    ]);
    expect(providers.SLACK.calls[0]).toMatchObject({ op: 'grant', resource: 'C08ABCDEF12' });

    const grants = await grantsOf(ctx.expert.id);
    expect(grants.map((g) => [g.system, g.status, g.provider])).toEqual([
      ['GITHUB', 'ACTIVE', 'live'],
      ['SLACK', 'ACTIVE', 'live'],
    ]);
    expect(grants[0]!.assignmentId).toBe(ctx.assignment.id);

    // Nothing changed, so nothing is called again.
    const second = await reconcileAccess(prisma, { providers });
    expect(second).toMatchObject({ granted: 0, revoked: 0 });
    expect(providers.GITHUB.calls).toHaveLength(1);
    expect(await prisma.activityEvent.count({ where: { action: 'access.granted' } })).toBe(2);
  });

  it('revokes access when the seat is released, using the login it was granted to', async () => {
    const ctx = await setup();
    const providers = fakes();
    await reconcileAccess(prisma, { providers });

    await releaseAssignment(prisma, ctx.actor, ctx.assignment.id, 'Client paused the project');
    expect(await prisma.job.count({ where: { type: 'access.reconcile' } })).toBeGreaterThan(0);
    // A later username change must not redirect the revoke.
    await prisma.expert.update({
      where: { id: ctx.expert.id },
      data: { githubUsername: 'someone-else' },
    });

    const result = await reconcileAccess(prisma, { providers });
    expect(result).toMatchObject({ revoked: 2 });
    expect(providers.GITHUB.calls.at(-1)).toEqual({
      op: 'revoke',
      resource: 'acme/evals',
      subject: 'ada-dev',
    });
    const grants = await grantsOf(ctx.expert.id);
    expect(grants.every((g) => g.status === 'REVOKED' && g.revokeReason === 'Seat released')).toBe(
      true,
    );
  });

  it('revokes when the engagement completes, the project closes or the expert is no longer verified', async () => {
    const ctx = await setup();
    const providers = fakes();
    await reconcileAccess(prisma, { providers });
    await completeAssignment(prisma, ctx.actor, ctx.assignment.id);
    await reconcileAccess(prisma, { providers });
    expect((await grantsOf(ctx.expert.id)).map((g) => g.revokeReason)).toEqual([
      'Engagement completed',
      'Engagement completed',
    ]);

    // A second expert, on the same project, loses access when it closes.
    const other = await makeExpert({ status: 'VERIFIED', fullName: 'Grace Example' });
    await prisma.expert.update({ where: { id: other.id }, data: { githubUsername: 'grace' } });
    await makeConfirmedAssignment(ctx.project.id, other.id);
    await reconcileAccess(prisma, { providers });
    expect((await grantsOf(other.id)).map((g) => g.status)).toEqual(['ACTIVE', 'ACTIVE']);
    await prisma.project.update({ where: { id: ctx.project.id }, data: { status: 'CLOSED' } });
    await reconcileAccess(prisma, { providers });
    expect((await grantsOf(other.id)).map((g) => g.revokeReason)).toEqual([
      'Project closed',
      'Project closed',
    ]);
  });

  it('removes everyone from a resource taken off the project', async () => {
    const ctx = await setup();
    const providers = fakes();
    await reconcileAccess(prisma, { providers });
    const response = await callRoute(
      accessAction,
      buildRequest('POST', `/api/projects/${ctx.project.id}/access`, {
        operatorToken: await operatorToken(ctx.operator),
        body: { action: 'remove', resourceId: ctx.channel.id },
      }),
      { projectId: ctx.project.id },
    );
    expect(response.status).toBe(200);
    await reconcileAccess(prisma, { providers });
    const grants = await grantsOf(ctx.expert.id);
    expect(grants.map((g) => [g.system, g.status])).toEqual([
      ['GITHUB', 'ACTIVE'],
      ['SLACK', 'REVOKED'],
    ]);
    expect(grants[1]!.revokeReason).toBe('Resource removed from the project');
  });

  it('waits for a GitHub username, then grants as soon as the expert adds one', async () => {
    const ctx = await setup({ githubUsername: null });
    const providers = fakes();
    await reconcileAccess(prisma, { providers });

    const [github] = await grantsOf(ctx.expert.id);
    expect(github).toMatchObject({ status: 'GRANT_FAILED' });
    expect(github!.lastError).toMatch(/No GitHub username/);
    const item = await prisma.attentionItem.findUniqueOrThrow({
      where: { dedupeKey: `access:grant:${github!.id}` },
    });
    expect(item).toMatchObject({ status: 'OPEN', severity: 'MEDIUM' });

    // The expert adds it (the portal route calls exactly this, scoped to them).
    await setGithubUsername(
      prisma,
      { type: 'EXPERT', label: ctx.expert.fullName, expertId: ctx.expert.id },
      ctx.expert.id,
      '@ada-dev',
    );
    expect((await grantsOf(ctx.expert.id))[0]).toMatchObject({ status: 'PENDING', subject: null });

    await reconcileAccess(prisma, { providers });
    expect((await grantsOf(ctx.expert.id))[0]).toMatchObject({
      status: 'ACTIVE',
      subject: 'ada-dev',
    });
    expect((await prisma.attentionItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'RESOLVED',
    );
  });

  it('moves GitHub access when the username changes', async () => {
    const ctx = await setup();
    const providers = fakes();
    await reconcileAccess(prisma, { providers });
    await setGithubUsername(prisma, ctx.actor, ctx.expert.id, 'ada-new');

    await reconcileAccess(prisma, { providers }); // revokes the old login
    await reconcileAccess(prisma, { providers }); // grants the new one
    expect(providers.GITHUB.calls.map((c) => `${c.op}:${c.subject}`)).toEqual([
      'grant:ada-dev',
      'revoke:ada-dev',
      'grant:ada-new',
    ]);
    expect((await grantsOf(ctx.expert.id))[0]).toMatchObject({
      status: 'ACTIVE',
      subject: 'ada-new',
    });
  });

  it('escalates a revoke that keeps failing, and records a manual removal', async () => {
    const ctx = await setup();
    const providers = fakes();
    await reconcileAccess(prisma, { providers });
    providers.SLACK.revokeAnswer = () => ({ kind: 'retry', error: 'Slack 503' });
    await releaseAssignment(prisma, ctx.actor, ctx.assignment.id, 'Ended early');

    for (let i = 0; i < MAX_ACCESS_ATTEMPTS; i += 1) await reconcileAccess(prisma, { providers });
    const slack = (await grantsOf(ctx.expert.id))[1]!;
    expect(slack).toMatchObject({ status: 'REVOKE_FAILED', lastError: 'Slack 503' });
    const item = await prisma.attentionItem.findUniqueOrThrow({
      where: { dedupeKey: `access:revoke:${slack.id}` },
    });
    expect(item).toMatchObject({ status: 'OPEN', severity: 'HIGH' });

    await expect(confirmManualRevoke(prisma, ctx.actor, slack.id, '  ')).rejects.toThrow(
      /Say what you did/,
    );
    await confirmManualRevoke(
      prisma,
      ctx.actor,
      slack.id,
      'Removed from #acme-evals in Slack admin',
    );
    expect((await grantsOf(ctx.expert.id))[1]!.status).toBe('REVOKED');
    expect((await prisma.attentionItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'RESOLVED',
    );
  });

  it('lets an operator retry a failed grant after fixing the cause', async () => {
    const ctx = await setup();
    const providers = fakes();
    providers.GITHUB.grantAnswer = () => ({ kind: 'failed', error: 'GitHub 404: Not Found' });
    await reconcileAccess(prisma, { providers });
    const [github] = await grantsOf(ctx.expert.id);
    expect(github!.status).toBe('GRANT_FAILED');

    providers.GITHUB.grantAnswer = () => ({
      kind: 'done',
      invitationId: '77',
      invitationPending: true,
    });
    await retryAccessGrant(prisma, ctx.actor, github!.id);
    await reconcileAccess(prisma, { providers });
    expect((await grantsOf(ctx.expert.id))[0]).toMatchObject({
      status: 'ACTIVE',
      invitationId: '77',
      invitationPending: true,
    });
    expect(
      await prisma.attentionItem.count({
        where: { status: 'OPEN', category: 'access.grant_failed' },
      }),
    ).toBe(0);
  });

  it('never reports a live grant revoked once its token is gone', async () => {
    const ctx = await setup();
    await reconcileAccess(prisma, { providers: fakes('live') });
    await releaseAssignment(prisma, ctx.actor, ctx.assignment.id, 'Done');

    const simulated = fakes('simulated');
    await reconcileAccess(prisma, { providers: simulated });
    expect(simulated.GITHUB.calls).toEqual([]);
    const grants = await grantsOf(ctx.expert.id);
    expect(grants.map((g) => g.status)).toEqual(['REVOKE_FAILED', 'REVOKE_FAILED']);
    expect(grants[0]!.lastError).toMatch(/no longer configured/);
  });

  it('turns simulated grants into real ones when a token is configured', async () => {
    const ctx = await setup();
    await reconcileAccess(prisma, { providers: fakes('simulated') });
    expect((await grantsOf(ctx.expert.id)).map((g) => g.provider)).toEqual([
      'simulated',
      'simulated',
    ]);

    const live = fakes('live');
    await reconcileAccess(prisma, { providers: live });
    expect(live.GITHUB.calls).toEqual([
      { op: 'grant', resource: 'acme/evals', subject: 'ada-dev' },
    ]);
    expect((await grantsOf(ctx.expert.id)).map((g) => g.provider)).toEqual(['live', 'live']);
  });

  it('checks permissions, input and project scope on the API', async () => {
    const ctx = await setup();
    const viewer = await makeOperator({ role: 'VIEWER', email: 'viewer@example.test' });
    const path = `/api/projects/${ctx.project.id}/access`;
    const call = async (token: string, body: unknown, projectId = ctx.project.id) =>
      callRoute(accessAction, buildRequest('POST', path, { operatorToken: token, body }), {
        projectId,
      });

    const viewerToken = await operatorToken(viewer);
    const opToken = await operatorToken(ctx.operator);
    expect(
      (await call(viewerToken, { action: 'add', system: 'GITHUB', resource: 'acme/x' })).status,
    ).toBe(403);
    expect(
      (await call(opToken, { action: 'add', system: 'GITHUB', resource: 'not a repo' })).status,
    ).toBe(400);
    expect(
      (await call(opToken, { action: 'add', system: 'SLACK', resource: '#general' })).status,
    ).toBe(400);

    // A grant from one project cannot be acted on through another project's URL.
    await reconcileAccess(prisma, { providers: fakes() });
    const grant = (await grantsOf(ctx.expert.id))[0]!;
    const elsewhere = await makeProject(ctx.operator.id, { status: 'STAFFING' });
    const crossed = await call(opToken, { action: 'retry', grantId: grant.id }, elsewhere.id);
    expect(crossed.status).toBe(404);
  });

  it('refuses the portal route without a session, and a malformed username', async () => {
    const ctx = await setup({ githubUsername: null });
    // Without a portal session the route refuses; the id never comes from the body.
    const anonymous = await callRoute(
      portalGithub,
      buildRequest('PUT', '/api/portal/github', { body: { githubUsername: 'ada-dev' } }),
    );
    expect(anonymous.status).toBe(401);
    await expect(setGithubUsername(prisma, ctx.actor, ctx.expert.id, 'not valid!')).rejects.toThrow(
      /not a valid GitHub username/,
    );
  });
});
