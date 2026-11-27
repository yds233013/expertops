import { createHash } from 'node:crypto';
import { type EvidenceRow, type GithubRef } from '@/server/domain/screening-signals';

/**
 * Looking up what a candidate claims.
 *
 * Two hosts are ever contacted, `api.github.com` and `services.nvd.nist.gov`,
 * with paths built from parsed, validated identifiers. A URL a candidate
 * submitted is never requested, so a submission cannot point the server at an
 * internal address.
 *
 * Every lookup is a read. That is what makes it safe inside the worker's job
 * transaction: a rollback costs a repeat request, nothing more.
 *
 * Lookups fail soft. A timeout or rate limit becomes an ERROR row saying so;
 * it is never read as "not found", because telling a reviewer a real account
 * does not exist is worse than telling them nothing.
 */
export interface EvidenceLookup {
  readonly mode: 'live' | 'simulated';
  github(ref: GithubRef): Promise<EvidenceRow[]>;
  cve(id: string): Promise<EvidenceRow>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LiveLookupOptions {
  githubToken?: string | null;
  nvdApiKey?: string | null;
  timeoutMs?: number;
  fetch?: FetchLike;
}

const USER_AGENT = 'ExpertOps-screening-checks';

export class LiveEvidenceLookup implements EvidenceLookup {
  readonly mode = 'live' as const;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: LiveLookupOptions = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  private async get(url: string, headers: Record<string, string>) {
    return this.fetchImpl(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
  }

  private githubHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.options.githubToken) headers.Authorization = `Bearer ${this.options.githubToken}`;
    return headers;
  }

  async github(ref: GithubRef): Promise<EvidenceRow[]> {
    const rows: EvidenceRow[] = [];
    rows.push(await this.githubUser(ref.login));
    if (ref.repo && rows[0]!.status !== 'NOT_FOUND') rows.push(await this.githubRepo(ref));
    return rows;
  }

  private async githubUser(login: string): Promise<EvidenceRow> {
    const subject = `github.com/${login}`;
    const base = { kind: 'GITHUB_PROFILE' as const, subject, url: `https://github.com/${login}` };
    try {
      const response = await this.get(
        `https://api.github.com/users/${encodeURIComponent(login)}`,
        this.githubHeaders(),
      );
      if (response.status === 404) {
        return {
          ...base,
          status: 'NOT_FOUND',
          detail: 'No GitHub account has this name.',
          url: null,
        };
      }
      if (!response.ok) return { ...base, status: 'ERROR', detail: githubFailure(response) };
      const body = (await response.json()) as {
        login: string;
        name: string | null;
        created_at: string;
        public_repos: number;
        followers: number;
        type: string;
      };
      return {
        ...base,
        status: 'VERIFIED',
        detail: `${body.type === 'Organization' ? 'Organisation' : 'Account'} created ${body.created_at.slice(0, 10)}, ${body.public_repos} public repositories, ${body.followers} followers${body.name ? `, profile name "${body.name}"` : ''}.`,
        facts: {
          accountCreatedAt: body.created_at,
          publicRepos: body.public_repos,
          followers: body.followers,
          profileName: body.name,
        },
      };
    } catch (error) {
      return { ...base, status: 'ERROR', detail: networkFailure(error) };
    }
  }

  private async githubRepo(ref: GithubRef): Promise<EvidenceRow> {
    const subject = `github.com/${ref.login}/${ref.repo}`;
    const base = { kind: 'GITHUB_REPO' as const, subject, url: `https://${subject}` };
    try {
      const response = await this.get(
        `https://api.github.com/repos/${encodeURIComponent(ref.login)}/${encodeURIComponent(ref.repo!)}`,
        this.githubHeaders(),
      );
      if (response.status === 404) {
        return {
          ...base,
          status: 'NOT_FOUND',
          detail: 'No public repository has this name.',
          url: null,
        };
      }
      if (!response.ok) return { ...base, status: 'ERROR', detail: githubFailure(response) };
      const body = (await response.json()) as {
        fork: boolean;
        stargazers_count: number;
        pushed_at: string | null;
        created_at: string;
        owner: { login: string };
      };
      return {
        ...base,
        status: 'VERIFIED',
        detail: `${body.fork ? 'A fork' : 'An original repository'}, created ${body.created_at.slice(0, 10)}, last pushed ${body.pushed_at?.slice(0, 10) ?? 'never'}, ${body.stargazers_count} stars.`,
        facts: { fork: body.fork, pushedAt: body.pushed_at, stars: body.stargazers_count },
      };
    } catch (error) {
      return { ...base, status: 'ERROR', detail: networkFailure(error) };
    }
  }

  async cve(id: string): Promise<EvidenceRow> {
    const base = {
      kind: 'CVE' as const,
      subject: id,
      url: `https://nvd.nist.gov/vuln/detail/${id}`,
    };
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.options.nvdApiKey) headers.apiKey = this.options.nvdApiKey;
      const response = await this.get(
        `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(id)}`,
        headers,
      );
      if (!response.ok) {
        return {
          ...base,
          status: 'ERROR',
          detail:
            response.status === 403 || response.status === 429
              ? 'The NVD rate limit was reached. Re-run the check later, or set NVD_API_KEY.'
              : `The NVD answered ${response.status}.`,
        };
      }
      const body = (await response.json()) as {
        totalResults: number;
        vulnerabilities?: Array<{
          cve: {
            published: string;
            vulnStatus: string;
            descriptions: Array<{ lang: string; value: string }>;
          };
        }>;
      };
      const found = body.vulnerabilities?.[0]?.cve;
      if (body.totalResults === 0 || !found) {
        return { ...base, status: 'NOT_FOUND', detail: 'Not in the NVD.', url: null };
      }
      const description =
        found.descriptions.find((d) => d.lang === 'en')?.value ??
        found.descriptions[0]?.value ??
        '';
      return {
        ...base,
        status: 'VERIFIED',
        detail: `Published ${found.published.slice(0, 10)} (${found.vulnStatus}). ${description.slice(0, 220)}${description.length > 220 ? '…' : ''}`,
      };
    } catch (error) {
      return { ...base, status: 'ERROR', detail: networkFailure(error) };
    }
  }
}

function githubFailure(response: Response): string {
  if (
    (response.status === 403 || response.status === 429) &&
    response.headers.get('x-ratelimit-remaining') === '0'
  ) {
    return 'The GitHub rate limit was reached. Re-run the check later, or set GITHUB_LOOKUP_TOKEN.';
  }
  return `GitHub answered ${response.status}.`;
}

function networkFailure(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'The lookup timed out.';
  }
  return 'The lookup could not reach the service.';
}

// ---------------------------------------------------------------------------
// Simulated
// ---------------------------------------------------------------------------

function unit(input: string): number {
  return createHash('sha256').update(input).digest().readUInt32BE(0) / 0xffffffff;
}

/**
 * Deterministic stand-in for the demo and the tests.
 *
 * Names containing "missing" or "fake" do not exist; names containing "fresh"
 * were created this week; anything else exists with stable, hash-derived
 * details. A CVE whose number starts with 9 does not exist. Every row says it
 * is simulated, so nobody mistakes it for a real check.
 */
export class SimulatedEvidenceLookup implements EvidenceLookup {
  readonly mode = 'simulated' as const;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async github(ref: GithubRef): Promise<EvidenceRow[]> {
    const subject = `github.com/${ref.login}`;
    if (/missing|fake/.test(ref.login)) {
      return [
        {
          kind: 'GITHUB_PROFILE',
          subject,
          status: 'NOT_FOUND',
          detail: 'Sandbox: no GitHub account has this name.',
          url: null,
        },
      ];
    }
    const ageDays = /fresh/.test(ref.login) ? 4 : 400 + Math.floor(unit(ref.login) * 3000);
    const created = new Date(this.now().getTime() - ageDays * 86_400_000).toISOString();
    const repos = 3 + Math.floor(unit(`repos:${ref.login}`) * 60);
    const rows: EvidenceRow[] = [
      {
        kind: 'GITHUB_PROFILE',
        subject,
        status: 'VERIFIED',
        detail: `Sandbox: account created ${created.slice(0, 10)}, ${repos} public repositories.`,
        url: `https://github.com/${ref.login}`,
        facts: {
          accountCreatedAt: created,
          publicRepos: repos,
          followers: repos * 2,
          profileName: null,
        },
      },
    ];
    if (ref.repo) {
      const missing = /missing|fake/.test(ref.repo);
      rows.push({
        kind: 'GITHUB_REPO',
        subject: `${subject}/${ref.repo}`,
        status: missing ? 'NOT_FOUND' : 'VERIFIED',
        detail: missing
          ? 'Sandbox: no public repository has this name.'
          : `Sandbox: an original repository, ${Math.floor(unit(`stars:${ref.repo}`) * 400)} stars.`,
        url: missing ? null : `https://${subject}/${ref.repo}`,
        facts: missing ? undefined : { fork: false, stars: 0, pushedAt: created },
      });
    }
    return rows;
  }

  async cve(id: string): Promise<EvidenceRow> {
    const missing = /^CVE-\d{4}-9/.test(id);
    return {
      kind: 'CVE',
      subject: id,
      status: missing ? 'NOT_FOUND' : 'VERIFIED',
      detail: missing ? 'Sandbox: not in the NVD.' : 'Sandbox: present in the NVD.',
      url: missing ? null : `https://nvd.nist.gov/vuln/detail/${id}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EvidenceConfig {
  mode: 'live' | 'simulated';
  githubToken: string | null;
  nvdApiKey: string | null;
}

export function evidenceConfig(
  env: Record<string, string | undefined> = process.env,
): EvidenceConfig {
  return {
    mode: env.SCREENING_EVIDENCE_LOOKUPS === 'live' ? 'live' : 'simulated',
    githubToken: env.GITHUB_LOOKUP_TOKEN?.trim() || null,
    nvdApiKey: env.NVD_API_KEY?.trim() || null,
  };
}

export function evidenceLookupFor(config: EvidenceConfig, now?: () => Date): EvidenceLookup {
  if (config.mode === 'live') {
    return new LiveEvidenceLookup({ githubToken: config.githubToken, nvdApiKey: config.nvdApiKey });
  }
  return new SimulatedEvidenceLookup(now);
}
