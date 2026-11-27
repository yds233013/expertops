import { describe, expect, it } from 'vitest';
import {
  accessProviders,
  GithubAccessProvider,
  SlackAccessProvider,
} from '@/server/integrations/access-providers';

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

/** A fetch that answers by "METHOD url" and remembers each request. */
function scripted(routes: Record<string, Answer | Answer[]>) {
  const calls: Array<{ key: string; body: string | undefined }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    const key = `${init.method} ${url}`;
    calls.push({ key, body: init.body as string | undefined });
    const route = routes[key];
    if (!route) throw new Error(`unexpected ${key}`);
    const answer = Array.isArray(route) ? route.shift()! : route;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: answer.headers,
    });
  };
  return { fetch, calls };
}

const repo = { resource: 'acme/evals', permission: 'push' };
const GH = 'https://api.github.com/repos/acme/evals';

describe('GitHub access', () => {
  it('invites a new collaborator and keeps the invitation id', async () => {
    const { fetch, calls } = scripted({
      [`PUT ${GH}/collaborators/ada`]: { status: 201, body: { id: 991 } },
    });
    const outcome = await new GithubAccessProvider({ token: 't', fetch }).grant(repo, 'ada');
    expect(outcome).toEqual({ kind: 'done', invitationId: '991', invitationPending: true });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ permission: 'push' });
  });

  it('treats an existing collaborator as done', async () => {
    const { fetch } = scripted({ [`PUT ${GH}/collaborators/ada`]: { status: 204 } });
    expect(await new GithubAccessProvider({ token: 't', fetch }).grant(repo, 'ada')).toEqual({
      kind: 'done',
      invitationPending: false,
    });
  });

  it('retries a server error and gives up on a missing repository', async () => {
    const flaky = scripted({ [`PUT ${GH}/collaborators/ada`]: { status: 502, body: {} } });
    expect(
      (await new GithubAccessProvider({ token: 't', fetch: flaky.fetch }).grant(repo, 'ada')).kind,
    ).toBe('retry');
    const missing = scripted({
      [`PUT ${GH}/collaborators/ada`]: { status: 404, body: { message: 'Not Found' } },
    });
    const outcome = await new GithubAccessProvider({ token: 't', fetch: missing.fetch }).grant(
      repo,
      'ada',
    );
    expect(outcome.kind).toBe('failed');
  });

  it('cancels a pending invitation, removes the collaborator and checks access is gone', async () => {
    const { fetch, calls } = scripted({
      [`DELETE ${GH}/invitations/991`]: { status: 204 },
      [`DELETE ${GH}/collaborators/ada`]: { status: 204 },
      [`GET ${GH}/collaborators/ada`]: { status: 404 },
    });
    const outcome = await new GithubAccessProvider({ token: 't', fetch }).revoke(repo, {
      subject: 'ada',
      invitationId: '991',
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(calls.map((c) => c.key.split(' ')[0])).toEqual(['DELETE', 'DELETE', 'GET']);
  });

  it('refuses to call it revoked while an organisation permission still lets them in', async () => {
    const { fetch } = scripted({
      [`DELETE ${GH}/collaborators/ada`]: { status: 204 },
      [`GET ${GH}/collaborators/ada`]: { status: 204 },
    });
    const outcome = await new GithubAccessProvider({ token: 't', fetch }).revoke(repo, {
      subject: 'ada',
      invitationId: null,
    });
    expect(outcome.kind).toBe('failed');
    expect((outcome as { error: string }).error).toMatch(/organisation base permission or a team/);
  });

  it('needs a username before it can grant anything', async () => {
    const outcome = await new GithubAccessProvider({ token: 't' }).resolveSubject({
      githubUsername: null,
    });
    expect(outcome.kind).toBe('failed');
  });
});

describe('Slack access', () => {
  const channel = { resource: 'C08ABCDEF12', permission: 'member' };
  const api = (method: string) => `POST https://slack.com/api/${method}`;

  it('looks a member up by email', async () => {
    const { fetch, calls } = scripted({
      [api('users.lookupByEmail')]: { status: 200, body: { ok: true, user: { id: 'U123' } } },
    });
    const outcome = await new SlackAccessProvider({ token: 'xoxb', fetch }).resolveSubject({
      slackUserId: null,
      email: 'ada@lab.dev',
    });
    expect(outcome).toEqual({ kind: 'ok', subject: 'U123' });
    expect(calls[0]!.body).toBe('email=ada%40lab.dev');
  });

  it('explains a person who is not in the workspace', async () => {
    const { fetch } = scripted({
      [api('users.lookupByEmail')]: { status: 200, body: { ok: false, error: 'users_not_found' } },
    });
    const outcome = await new SlackAccessProvider({ token: 'xoxb', fetch }).resolveSubject({
      slackUserId: null,
      email: 'ada@lab.dev',
    });
    expect(outcome.kind).toBe('failed');
    expect((outcome as { error: string }).error).toMatch(/Invite them to the workspace/);
  });

  it('treats already-in-channel and not-in-channel as success', async () => {
    const { fetch } = scripted({
      [api('conversations.invite')]: {
        status: 200,
        body: { ok: false, error: 'already_in_channel' },
      },
      [api('conversations.kick')]: { status: 200, body: { ok: false, error: 'not_in_channel' } },
    });
    const slack = new SlackAccessProvider({ token: 'xoxb', fetch });
    expect(await slack.grant(channel, 'U123')).toEqual({ kind: 'done' });
    expect(await slack.revoke(channel, { subject: 'U123' })).toEqual({ kind: 'done' });
  });

  it('retries a rate limit and fails a permissions problem with the reason', async () => {
    const { fetch } = scripted({
      [api('conversations.invite')]: [
        { status: 429 },
        { status: 200, body: { ok: false, error: 'missing_scope' } },
      ],
    });
    const slack = new SlackAccessProvider({ token: 'xoxb', fetch });
    expect((await slack.grant(channel, 'U1')).kind).toBe('retry');
    const failed = await slack.grant(channel, 'U1');
    expect(failed.kind).toBe('failed');
    expect((failed as { error: string }).error).toMatch(/channels:manage/);
  });
});

describe('provider configuration', () => {
  it('is simulated per system until that system’s token is set', () => {
    expect(accessProviders({}).GITHUB.mode).toBe('simulated');
    expect(accessProviders({}).SLACK.mode).toBe('simulated');
    const mixed = accessProviders({ GITHUB_ADMIN_TOKEN: 'github_pat_x' });
    expect(mixed.GITHUB.mode).toBe('live');
    expect(mixed.SLACK.mode).toBe('simulated');
  });
});
