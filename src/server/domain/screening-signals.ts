/**
 * Screening signals: the pure part of checking a screening submission.
 *
 * Everything here is a function of its inputs. No database, no network, no
 * clock. The service layer gathers inputs (the submission, other candidates'
 * submissions on the same rubric, API lookups) and this module turns them into
 * evidence rows and integrity flags.
 *
 * None of it decides anything. A flag is a reason for a reviewer to look
 * harder, written so the reviewer can check it themselves.
 */

// ---------------------------------------------------------------------------
// Claims a candidate makes that can be checked
// ---------------------------------------------------------------------------

export interface GithubRef {
  login: string;
  repo: string | null;
}

export interface ExtractedClaims {
  github: GithubRef[];
  cves: string[];
  /** Bar admissions mentioned in an answer. No public API covers them. */
  barClaims: string[];
}

/** GitHub logins: alphanumeric or single hyphens, 1 to 39 characters. */
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const GITHUB_REPO = /^[\w.-]{1,100}$/;

/** Paths on github.com that are not user or organisation names. */
const GITHUB_RESERVED = new Set([
  'about',
  'apps',
  'collections',
  'enterprise',
  'events',
  'explore',
  'features',
  'issues',
  'login',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'pricing',
  'pulls',
  'search',
  'settings',
  'sponsors',
  'topics',
  'trending',
]);

/**
 * Parse a GitHub profile or repository out of a link.
 *
 * Only `github.com` itself counts: a lookalike host, or a gist or raw URL, is
 * ignored rather than guessed at.
 */
export function parseGithubLink(link: string): GithubRef | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;

  const [login, repo] = url.pathname.split('/').filter(Boolean);
  if (!login || !GITHUB_LOGIN.test(login) || GITHUB_RESERVED.has(login.toLowerCase())) {
    return null;
  }
  const cleanRepo = repo?.replace(/\.git$/i, '');
  return {
    login: login.toLowerCase(),
    repo: cleanRepo && GITHUB_REPO.test(cleanRepo) ? cleanRepo.toLowerCase() : null,
  };
}

const CVE_PATTERN = /\bCVE-(\d{4})-(\d{4,7})\b/gi;
const GITHUB_IN_TEXT = /\bhttps?:\/\/(?:www\.)?github\.com\/[^\s)>\]"']+/gi;
const BAR_PATTERN =
  /\b(?:bar\s*(?:no\.?|number|#|id|admission)|admitted to the [a-z .]+ bar|state bar of [a-z ]+)[^.\n]{0,60}/gi;

/** At most this many lookups per submission, so one submission cannot hog the API quota. */
export const MAX_LOOKUPS = 8;

export function extractClaims(answers: Record<string, string>, links: string[]): ExtractedClaims {
  const text = Object.values(answers).join('\n');

  const github = new Map<string, GithubRef>();
  // A link at the end of a sentence carries its full stop; drop trailing punctuation.
  const inText = (text.match(GITHUB_IN_TEXT) ?? []).map((link) => link.replace(/[.,;:!?]+$/, ''));
  for (const link of [...links, ...inText]) {
    const ref = parseGithubLink(link);
    if (ref) github.set(`${ref.login}/${ref.repo ?? ''}`, ref);
  }

  const cves = new Set<string>();
  for (const match of text.matchAll(CVE_PATTERN)) {
    cves.add(`CVE-${match[1]}-${match[2]}`);
  }

  const barClaims = new Set<string>();
  for (const match of text.matchAll(BAR_PATTERN)) {
    barClaims.add(match[0].trim().replace(/\s+/g, ' ').slice(0, 120));
  }

  const githubRefs = [...github.values()];
  const cveList = [...cves];
  // Repositories before bare profiles, since a repository check also covers
  // its owner. Then cap the total.
  githubRefs.sort((a, b) => Number(b.repo !== null) - Number(a.repo !== null));
  // Half the budget each, and either kind may use what the other leaves.
  const cveCount = Math.min(
    cveList.length,
    MAX_LOOKUPS - Math.min(githubRefs.length, MAX_LOOKUPS / 2),
  );
  return {
    github: githubRefs.slice(0, MAX_LOOKUPS - cveCount),
    cves: cveList.slice(0, cveCount),
    barClaims: [...barClaims].slice(0, 3),
  };
}

// ---------------------------------------------------------------------------
// Evidence rows
// ---------------------------------------------------------------------------

export type EvidenceStatus = 'VERIFIED' | 'NOT_FOUND' | 'MANUAL' | 'ERROR';

export interface EvidenceRow {
  kind: 'GITHUB_PROFILE' | 'GITHUB_REPO' | 'CVE' | 'BAR_ADMISSION';
  subject: string;
  status: EvidenceStatus;
  detail: string;
  url: string | null;
  /** Facts a flag may depend on, kept so the flag can be re-derived. */
  facts?: {
    accountCreatedAt?: string;
    publicRepos?: number;
    followers?: number;
    profileName?: string | null;
    fork?: boolean;
    pushedAt?: string | null;
    stars?: number;
  };
}

// ---------------------------------------------------------------------------
// Copied answers
// ---------------------------------------------------------------------------

/** An answer shorter than this is too generic to call a copy. */
export const MIN_WORDS_FOR_SIMILARITY = 40;
/** Share of five-word phrases two answers have in common. */
export const COPY_THRESHOLD = 0.6;
const SHINGLE = 5;

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function shingles(text: string): Set<string> {
  const tokens = words(text);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= tokens.length; i += 1) {
    out.add(tokens.slice(i, i + SHINGLE).join(' '));
  }
  return out;
}

/** Jaccard similarity of two shingle sets, 0 to 1. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export interface PeerSubmission {
  screeningReference: string;
  candidateId: string;
  answers: Record<string, string>;
  githubLogins: string[];
}

export interface CopyMatch {
  criterionKey: string;
  screeningReference: string;
  similarity: number;
}

/**
 * Answers that substantially repeat another candidate's answer to the same
 * criterion. Only other candidates count: a candidate's own earlier revision
 * is expected to overlap.
 */
export function findCopies(
  candidateId: string,
  answers: Record<string, string>,
  peers: PeerSubmission[],
): CopyMatch[] {
  const matches: CopyMatch[] = [];
  for (const [key, answer] of Object.entries(answers)) {
    if (words(answer).length < MIN_WORDS_FOR_SIMILARITY) continue;
    const mine = shingles(answer);
    let best: CopyMatch | null = null;
    for (const peer of peers) {
      if (peer.candidateId === candidateId) continue;
      const theirs = peer.answers[key];
      if (!theirs || words(theirs).length < MIN_WORDS_FOR_SIMILARITY) continue;
      const score = similarity(mine, shingles(theirs));
      if (score >= COPY_THRESHOLD && (!best || score > best.similarity)) {
        best = {
          criterionKey: key,
          screeningReference: peer.screeningReference,
          similarity: score,
        };
      }
    }
    if (best) matches.push(best);
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Text aimed at an automated grader
// ---------------------------------------------------------------------------

const GRADER_INSTRUCTIONS = [
  /ignore (?:all |any )?(?:the )?(?:previous|prior|above) (?:instructions|rules)/i,
  /\b(?:as|you are) an? (?:ai|automated|llm) (?:grader|reviewer|evaluator|scorer)\b/i,
  /\b(?:give|award|assign) (?:me|this (?:answer|submission)) (?:a |the )?(?:full|maximum|max|perfect|highest) (?:score|marks|points)\b/i,
  /\bsystem prompt\b/i,
  /<\/?(?:system|instructions?|answer|candidate_answers?)>/i,
];

/** Whether an answer contains text addressed to a model rather than a person. */
export function addressesGrader(answers: Record<string, string>): boolean {
  return Object.values(answers).some((answer) =>
    GRADER_INSTRUCTIONS.some((pattern) => pattern.test(answer)),
  );
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type FlagSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export type FlagCode =
  | 'COPIED_ANSWER'
  | 'SHARED_GITHUB'
  | 'NEW_GITHUB_ACCOUNT'
  | 'GITHUB_NOT_FOUND'
  | 'CVE_NOT_FOUND'
  | 'INSTRUCTIONS_TO_GRADER'
  | 'FAST_SUBMISSION';

export interface Flag {
  code: FlagCode;
  severity: FlagSeverity;
  detail: string;
  relatedReference: string | null;
}

export const FLAG_LABELS: Record<FlagCode, string> = {
  COPIED_ANSWER: 'Answer matches another candidate',
  SHARED_GITHUB: 'GitHub account cited by another candidate',
  NEW_GITHUB_ACCOUNT: 'Recently created GitHub account',
  GITHUB_NOT_FOUND: 'Cited GitHub account or repository does not exist',
  CVE_NOT_FOUND: 'Cited CVE does not exist',
  INSTRUCTIONS_TO_GRADER: 'Answer contains instructions to an automated grader',
  FAST_SUBMISSION: 'Long submission completed very quickly',
};

export const NEW_ACCOUNT_DAYS = 90;
export const FAST_SUBMISSION_MINUTES = 10;
export const FAST_SUBMISSION_MIN_WORDS = 300;

export interface FlagInputs {
  candidateId: string;
  answers: Record<string, string>;
  evidence: EvidenceRow[];
  copies: CopyMatch[];
  /** Other candidates citing the same GitHub login: login -> screening references. */
  sharedLogins: Map<string, string[]>;
  /** When the candidate could start this revision, and when they submitted it. */
  startedAt: Date;
  submittedAt: Date;
  checkedAt: Date;
}

const SEVERITY_ORDER: Record<FlagSeverity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export function deriveFlags(input: FlagInputs): Flag[] {
  const flags: Flag[] = [];

  for (const copy of input.copies) {
    flags.push({
      code: 'COPIED_ANSWER',
      severity: 'HIGH',
      detail: `The answer to "${copy.criterionKey}" shares ${Math.round(copy.similarity * 100)}% of its phrasing with ${copy.screeningReference}. Read both before deciding: a shared source, or a template the two were given, can also explain it.`,
      relatedReference: copy.screeningReference,
    });
  }

  for (const [login, references] of input.sharedLogins) {
    flags.push({
      code: 'SHARED_GITHUB',
      severity: 'HIGH',
      detail: `github.com/${login} is also cited as their own by ${references.join(', ')}.`,
      relatedReference: references[0] ?? null,
    });
  }

  for (const row of input.evidence) {
    if (
      row.status === 'NOT_FOUND' &&
      (row.kind === 'GITHUB_PROFILE' || row.kind === 'GITHUB_REPO')
    ) {
      flags.push({
        code: 'GITHUB_NOT_FOUND',
        severity: 'MEDIUM',
        detail: `${row.subject} was not found on GitHub. It may be private, renamed or mistyped.`,
        relatedReference: null,
      });
    }
    if (row.status === 'NOT_FOUND' && row.kind === 'CVE') {
      flags.push({
        code: 'CVE_NOT_FOUND',
        severity: 'MEDIUM',
        detail: `${row.subject} is not in the NVD. A reserved or rejected id, or a typo, can also cause this.`,
        relatedReference: null,
      });
    }
    const created = row.facts?.accountCreatedAt;
    if (row.kind === 'GITHUB_PROFILE' && row.status === 'VERIFIED' && created) {
      const ageDays = (input.checkedAt.getTime() - new Date(created).getTime()) / 86_400_000;
      if (ageDays < NEW_ACCOUNT_DAYS) {
        flags.push({
          code: 'NEW_GITHUB_ACCOUNT',
          severity: 'MEDIUM',
          detail: `${row.subject} was created ${Math.max(0, Math.floor(ageDays))} day(s) ago, so it says little about past work.`,
          relatedReference: null,
        });
      }
    }
  }

  if (addressesGrader(input.answers)) {
    flags.push({
      code: 'INSTRUCTIONS_TO_GRADER',
      severity: 'HIGH',
      detail:
        'An answer contains text aimed at an automated grader. Score it yourself; the suggested scores may be affected.',
      relatedReference: null,
    });
  }

  const totalWords = Object.values(input.answers).reduce((sum, a) => sum + words(a).length, 0);
  const minutes = (input.submittedAt.getTime() - input.startedAt.getTime()) / 60_000;
  if (
    minutes >= 0 &&
    minutes < FAST_SUBMISSION_MINUTES &&
    totalWords >= FAST_SUBMISSION_MIN_WORDS
  ) {
    flags.push({
      code: 'FAST_SUBMISSION',
      severity: 'LOW',
      detail: `${totalWords} words submitted ${Math.max(1, Math.round(minutes))} minute(s) after the screening opened. Pasting a prepared answer is normal; pasting someone else's is not.`,
      relatedReference: null,
    });
  }

  return flags.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
}

export function highestSeverity(flags: Flag[]): FlagSeverity | null {
  let best: FlagSeverity | null = null;
  for (const flag of flags) {
    if (!best || SEVERITY_ORDER[flag.severity] > SEVERITY_ORDER[best]) best = flag.severity;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Suggested scores
// ---------------------------------------------------------------------------

export interface CriterionForScoring {
  key: string;
  label: string;
  scoringGuidance: string;
  maxScore: number;
  weight: number;
  isGating: boolean;
}

export interface RawSuggestion {
  key: string;
  score: number;
  rationale: string;
  quote: string;
}

export interface SuggestedScore {
  key: string;
  label: string;
  score: number;
  maxScore: number;
  weight: number;
  isGating: boolean;
  rationale: string;
  quote: string;
  /** Whether the quote appears in the answer. A rationale citing text the
   * candidate never wrote is shown with a warning, not hidden. */
  quoteFound: boolean;
}

export interface ScoreSummary {
  scores: SuggestedScore[];
  total: number;
  maxTotal: number;
  pass: boolean;
}

function normaliseForQuote(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Turn a scorer's raw output into stored suggestions.
 *
 * Defensive by design: a missing criterion scores 0 with a note, a score is
 * clamped to the criterion's range, and a quote is checked against the answer.
 * The model's output is never trusted to be well formed.
 */
export function summariseSuggestions(
  criteria: CriterionForScoring[],
  answers: Record<string, string>,
  raw: RawSuggestion[],
  passThreshold: number,
): ScoreSummary {
  const byKey = new Map(raw.map((item) => [item.key, item]));
  const scores = criteria.map((criterion): SuggestedScore => {
    const item = byKey.get(criterion.key);
    const score = item ? Math.max(0, Math.min(criterion.maxScore, Math.round(item.score))) : 0;
    const quote = (item?.quote ?? '').trim().slice(0, 300);
    const answer = normaliseForQuote(answers[criterion.key] ?? '');
    return {
      key: criterion.key,
      label: criterion.label,
      score,
      maxScore: criterion.maxScore,
      weight: criterion.weight,
      isGating: criterion.isGating,
      rationale: item
        ? item.rationale.trim().slice(0, 600)
        : 'No suggestion was returned for this criterion.',
      quote,
      quoteFound: quote.length > 0 && answer.includes(normaliseForQuote(quote)),
    };
  });

  const total = scores.reduce((sum, s) => sum + s.score * s.weight, 0);
  const maxTotal = scores.reduce((sum, s) => sum + s.maxScore * s.weight, 0);
  const gatesPass = scores.every((s) => !s.isGating || s.score >= Math.ceil(s.maxScore / 2));
  return { scores, total, maxTotal, pass: total >= passThreshold && gatesPass };
}
