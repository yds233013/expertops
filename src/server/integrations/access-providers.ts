import { createHash } from 'node:crypto';
import { type AccessSystem } from '@prisma/client';

/**
 * Granting and removing access in client systems.
 *
 * One provider per system, each live only when its token is configured:
 *
 *  - GitHub: repository collaborator, with `GITHUB_ADMIN_TOKEN` (a fine-grained
 *    token with Administration: write on the client's repositories).
 *  - Slack: channel membership, with `SLACK_BOT_TOKEN` (a bot with
 *    `channels:manage`, `groups:write` and `users:read.email`, invited to each
 *    channel it manages).
 *
 * Every operation is idempotent at the provider: adding an existing
 * collaborator, inviting someone already in a channel, or removing someone
 * already gone all succeed. That is what makes a retry after a crash safe.
 *
 * A provider never reports success it did not observe. When GitHub accepts a
 * removal but the person can still reach the repository (organisation base
 * permission, a team), the revoke fails and says why, because "revoked" would
 * be false.
 */
export type AccessOutcome =
  | { kind: 'done'; invitationId?: string | null; invitationPending?: boolean }
  | { kind: 'retry'; error: string }
  | { kind: 'failed'; error: string };

export type SubjectOutcome =
  | { kind: 'ok'; subject: string }
  | { kind: 'retry'; error: string }
  | { kind: 'failed'; error: string };

export interface AccessResourceRef {
  resource: string;
  permission: string;
}

export interface AccessProvider {
  readonly system: AccessSystem;
  readonly mode: 'live' | 'simulated';
  resolveSubject(expert: {
    githubUsername: string | null;
    slackUserId: string | null;
    email: string;
  }): Promise<SubjectOutcome>;
  grant(resource: AccessResourceRef, subject: string): Promise<AccessOutcome>;
  revoke(
    resource: AccessResourceRef,
    grant: { subject: string; invitationId: string | null },
  ): Promise<AccessOutcome>;
  /** Whether a pending invitation has been accepted. Null when unknown. */
  invitationAccepted(resource: AccessResourceRef, subject: string): Promise<boolean | null>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const MISSING_GITHUB_USERNAME =
  'No GitHub username on file. Ask the expert to add it in their portal, or add it on their profile.';

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export class GithubAccessProvider implements AccessProvider {
  readonly system = 'GITHUB' as const;
  readonly mode = 'live' as const;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: { token: string; fetch?: FetchLike; timeoutMs?: number }) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  }

  private request(method: string, path: string, body?: unknown) {
    return this.fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.options.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ExpertOps-access',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      redirect: 'error',
    });
  }

  private static repoPath(resource: string): string {
    const [owner, repo] = resource.split('/');
    return `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}`;
  }

  async resolveSubject(expert: { githubUsername: string | null }): Promise<SubjectOutcome> {
    return expert.githubUsername
      ? { kind: 'ok', subject: expert.githubUsername }
      : { kind: 'failed', error: MISSING_GITHUB_USERNAME };
  }

  async grant(resource: AccessResourceRef, subject: string): Promise<AccessOutcome> {
    try {
      const response = await this.request(
        'PUT',
        `${GithubAccessProvider.repoPath(resource.resource)}/collaborators/${encodeURIComponent(subject)}`,
        { permission: resource.permission },
      );
      if (response.status === 201) {
        const body = (await response.json().catch(() => ({}))) as { id?: number };
        return {
          kind: 'done',
          invitationId: body.id ? String(body.id) : null,
          invitationPending: true,
        };
      }
      if (response.status === 204) return { kind: 'done', invitationPending: false };
      return classifyGithub(response, 'grant');
    } catch (error) {
      return { kind: 'retry', error: networkError(error) };
    }
  }

  async revoke(
    resource: AccessResourceRef,
    grant: { subject: string; invitationId: string | null },
  ): Promise<AccessOutcome> {
    const repo = GithubAccessProvider.repoPath(resource.resource);
    try {
      if (grant.invitationId) {
        const cancelled = await this.request(
          'DELETE',
          `${repo}/invitations/${encodeURIComponent(grant.invitationId)}`,
        );
        if (cancelled.status !== 204 && cancelled.status !== 404) {
          return classifyGithub(cancelled, 'revoke');
        }
      }
      const removed = await this.request(
        'DELETE',
        `${repo}/collaborators/${encodeURIComponent(grant.subject)}`,
      );
      if (removed.status !== 204 && removed.status !== 404) {
        return classifyGithub(removed, 'revoke');
      }
      // Removing the collaborator is not the same as removing access.
      const check = await this.request(
        'GET',
        `${repo}/collaborators/${encodeURIComponent(grant.subject)}`,
      );
      if (check.status === 204) {
        return {
          kind: 'failed',
          error: `${grant.subject} was removed as a collaborator but can still reach ${resource.resource}, through an organisation base permission or a team. Remove them there.`,
        };
      }
      if (check.status !== 404) return classifyGithub(check, 'revoke');
      return { kind: 'done' };
    } catch (error) {
      return { kind: 'retry', error: networkError(error) };
    }
  }

  async invitationAccepted(resource: AccessResourceRef, subject: string) {
    try {
      const response = await this.request(
        'GET',
        `${GithubAccessProvider.repoPath(resource.resource)}/collaborators/${encodeURIComponent(subject)}`,
      );
      if (response.status === 204) return true;
      if (response.status === 404) return false;
      return null;
    } catch {
      return null;
    }
  }
}

async function classifyGithub(response: Response, op: 'grant' | 'revoke'): Promise<AccessOutcome> {
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  const message = body.message ? `: ${body.message}` : '';
  if (response.status === 429 || response.status >= 500) {
    return { kind: 'retry', error: `GitHub ${response.status}${message}` };
  }
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    return { kind: 'retry', error: 'GitHub rate limit reached.' };
  }
  if (response.status === 401) {
    return { kind: 'failed', error: 'GitHub rejected GITHUB_ADMIN_TOKEN. It may have expired.' };
  }
  if (response.status === 403 || response.status === 404) {
    return {
      kind: 'failed',
      error:
        op === 'grant'
          ? `GitHub ${response.status}${message}. The repository or user may not exist, or the token cannot administer this repository.`
          : `GitHub ${response.status}${message}. The token cannot administer this repository, so removal must be done by hand.`,
    };
  }
  return { kind: 'failed', error: `GitHub ${response.status}${message}` };
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

const SLACK_HARMLESS: Record<'grant' | 'revoke', string[]> = {
  grant: ['already_in_channel'],
  revoke: ['not_in_channel'],
};

const SLACK_EXPLANATIONS: Record<string, string> = {
  channel_not_found: 'The channel does not exist, or the bot cannot see it.',
  not_in_channel: 'The bot is not a member of the channel. Invite the bot to it first.',
  user_is_restricted:
    'The member is a single-channel guest. A workspace admin has to change their channels.',
  restricted_action: 'Workspace settings stop the bot from doing this. A Slack admin has to.',
  cant_kick_self: 'The bot cannot remove itself.',
  missing_scope: 'The bot token is missing a scope (channels:manage, groups:write).',
  invalid_auth: 'Slack rejected SLACK_BOT_TOKEN.',
  token_revoked: 'SLACK_BOT_TOKEN has been revoked.',
  users_not_found:
    'No Slack member has this email address. Invite them to the workspace (as a guest if needed), then retry.',
  is_archived: 'The channel is archived.',
};

export class SlackAccessProvider implements AccessProvider {
  readonly system = 'SLACK' as const;
  readonly mode = 'live' as const;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: { token: string; fetch?: FetchLike; timeoutMs?: number }) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  }

  private async call(
    method: string,
    params: Record<string, string>,
  ): Promise<
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; outcome: AccessOutcome; code: string }
  > {
    let response: Response;
    try {
      response = await this.fetchImpl(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        redirect: 'error',
      });
    } catch (error) {
      return { ok: false, outcome: { kind: 'retry', error: networkError(error) }, code: 'network' };
    }
    if (response.status === 429 || response.status >= 500) {
      return {
        ok: false,
        outcome: { kind: 'retry', error: `Slack ${response.status}` },
        code: String(response.status),
      };
    }
    const body = (await response.json().catch(() => ({ ok: false, error: 'bad_json' }))) as {
      ok: boolean;
      error?: string;
    } & Record<string, unknown>;
    if (body.ok) return { ok: true, body };
    const code = body.error ?? 'unknown_error';
    const error = `Slack ${code}: ${SLACK_EXPLANATIONS[code] ?? 'see the Slack API documentation.'}`;
    return {
      ok: false,
      outcome: code === 'ratelimited' ? { kind: 'retry', error } : { kind: 'failed', error },
      code,
    };
  }

  async resolveSubject(expert: {
    slackUserId: string | null;
    email: string;
  }): Promise<SubjectOutcome> {
    if (expert.slackUserId) return { kind: 'ok', subject: expert.slackUserId };
    const result = await this.call('users.lookupByEmail', { email: expert.email });
    if (!result.ok) {
      return result.outcome.kind === 'done'
        ? { kind: 'failed', error: 'Unexpected Slack reply.' }
        : result.outcome;
    }
    const user = result.body.user as { id?: string } | undefined;
    return user?.id
      ? { kind: 'ok', subject: user.id }
      : { kind: 'failed', error: 'Slack returned no member id.' };
  }

  async grant(resource: AccessResourceRef, subject: string): Promise<AccessOutcome> {
    const result = await this.call('conversations.invite', {
      channel: resource.resource,
      users: subject,
    });
    if (result.ok || SLACK_HARMLESS.grant.includes(result.code)) return { kind: 'done' };
    return result.outcome;
  }

  async revoke(resource: AccessResourceRef, grant: { subject: string }): Promise<AccessOutcome> {
    const result = await this.call('conversations.kick', {
      channel: resource.resource,
      user: grant.subject,
    });
    if (result.ok || SLACK_HARMLESS.revoke.includes(result.code)) return { kind: 'done' };
    return result.outcome;
  }

  async invitationAccepted() {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Simulated
// ---------------------------------------------------------------------------

/**
 * Records what it was asked and succeeds. GitHub still needs a username, as
 * the real one does, so the demo shows that failure honestly. Every grant it
 * makes is stored with provider "simulated" and labelled so in the UI.
 */
export class SimulatedAccessProvider implements AccessProvider {
  readonly mode = 'simulated' as const;
  readonly calls: Array<{ op: 'grant' | 'revoke'; resource: string; subject: string }> = [];

  constructor(readonly system: AccessSystem) {}

  async resolveSubject(expert: {
    githubUsername: string | null;
    slackUserId: string | null;
    email: string;
  }): Promise<SubjectOutcome> {
    if (this.system === 'GITHUB') {
      return expert.githubUsername
        ? { kind: 'ok', subject: expert.githubUsername }
        : { kind: 'failed', error: MISSING_GITHUB_USERNAME };
    }
    if (expert.slackUserId) return { kind: 'ok', subject: expert.slackUserId };
    const hash = createHash('sha256').update(expert.email).digest('hex').slice(0, 9).toUpperCase();
    return { kind: 'ok', subject: `USIM${hash}` };
  }

  async grant(resource: AccessResourceRef, subject: string): Promise<AccessOutcome> {
    this.calls.push({ op: 'grant', resource: resource.resource, subject });
    return { kind: 'done', invitationPending: false };
  }

  async revoke(resource: AccessResourceRef, grant: { subject: string }): Promise<AccessOutcome> {
    this.calls.push({ op: 'revoke', resource: resource.resource, subject: grant.subject });
    return { kind: 'done' };
  }

  async invitationAccepted() {
    return true;
  }
}

function networkError(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'The request timed out.';
  }
  return 'Could not reach the service.';
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type AccessProviders = Record<AccessSystem, AccessProvider>;

export function accessProviders(
  env: Record<string, string | undefined> = process.env,
): AccessProviders {
  const github = env.GITHUB_ADMIN_TOKEN?.trim();
  const slack = env.SLACK_BOT_TOKEN?.trim();
  return {
    GITHUB: github
      ? new GithubAccessProvider({ token: github })
      : new SimulatedAccessProvider('GITHUB'),
    SLACK: slack ? new SlackAccessProvider({ token: slack }) : new SimulatedAccessProvider('SLACK'),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const GITHUB_REPO_PATTERN =
  /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}\/[\w.-]{1,100}$/;
export const SLACK_CHANNEL_PATTERN = /^[CG][A-Z\d]{8,}$/;
export const GITHUB_USERNAME_PATTERN = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;
export const GITHUB_PERMISSIONS = ['pull', 'triage', 'push', 'maintain'] as const;
