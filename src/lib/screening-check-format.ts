import {
  FLAG_LABELS,
  type EvidenceRow,
  type EvidenceStatus,
  type Flag,
  type FlagCode,
  type FlagSeverity,
  type SuggestedScore,
} from '@/server/domain/screening-signals';

/**
 * Reading a stored screening check for display.
 *
 * The JSON columns are written by the worker, but a row from an older build or
 * a hand-edited seed should not take the review page down, so every reader
 * drops what it does not recognise rather than trusting the shape.
 */

type Json = unknown;

function isRecord(value: Json): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const SEVERITIES: FlagSeverity[] = ['HIGH', 'MEDIUM', 'LOW'];
const SEVERITY_RANK: Record<FlagSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const EVIDENCE_STATUSES: EvidenceStatus[] = ['VERIFIED', 'NOT_FOUND', 'MANUAL', 'ERROR'];
const EVIDENCE_KINDS: EvidenceRow['kind'][] = [
  'GITHUB_PROFILE',
  'GITHUB_REPO',
  'CVE',
  'BAR_ADMISSION',
];

function isFlagCode(value: unknown): value is FlagCode {
  return typeof value === 'string' && value in FLAG_LABELS;
}

/** Flags, most serious first. */
export function readFlags(value: Json): Flag[] {
  if (!Array.isArray(value)) return [];
  const flags: Flag[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isFlagCode(item.code)) continue;
    const severity = SEVERITIES.find((s) => s === item.severity) ?? 'LOW';
    flags.push({
      code: item.code,
      severity,
      detail: text(item.detail),
      relatedReference: text(item.relatedReference) || null,
    });
  }
  return flags.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export function readEvidence(value: Json): EvidenceRow[] {
  if (!Array.isArray(value)) return [];
  const rows: EvidenceRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const kind = EVIDENCE_KINDS.find((k) => k === item.kind);
    const status = EVIDENCE_STATUSES.find((s) => s === item.status);
    if (!kind || !status) continue;
    const url = text(item.url);
    rows.push({
      kind,
      status,
      subject: text(item.subject),
      detail: text(item.detail),
      // Only ever a link the lookup built. Anything else is shown as text.
      url: /^https:\/\//.test(url) ? url : null,
    });
  }
  return rows;
}

export function readSuggestedScores(value: Json): SuggestedScore[] {
  if (!Array.isArray(value)) return [];
  const scores: SuggestedScore[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.key !== 'string') continue;
    scores.push({
      key: item.key,
      label: text(item.label) || item.key,
      score: typeof item.score === 'number' ? item.score : 0,
      maxScore: typeof item.maxScore === 'number' ? item.maxScore : 0,
      weight: typeof item.weight === 'number' ? item.weight : 1,
      isGating: item.isGating === true,
      rationale: text(item.rationale),
      quote: text(item.quote),
      quoteFound: item.quoteFound === true,
    });
  }
  return scores;
}

export { FLAG_LABELS };

export const SEVERITY_LABEL: Record<FlagSeverity, string> = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

export const EVIDENCE_KIND_LABEL: Record<EvidenceRow['kind'], string> = {
  GITHUB_PROFILE: 'GitHub account',
  GITHUB_REPO: 'GitHub repository',
  CVE: 'CVE',
  BAR_ADMISSION: 'Bar admission',
};

export const EVIDENCE_STATUS: Record<
  EvidenceStatus,
  { label: string; glyph: string; tone: 'success' | 'warning' | 'neutral' | 'danger' }
> = {
  VERIFIED: { label: 'Found', glyph: '✓', tone: 'success' },
  NOT_FOUND: { label: 'Not found', glyph: '✕', tone: 'danger' },
  MANUAL: { label: 'Check by hand', glyph: '✎', tone: 'warning' },
  // A timeout or rate limit. Never read as "not found".
  ERROR: { label: 'Lookup failed', glyph: '!', tone: 'neutral' },
};
