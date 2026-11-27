import { type Prisma, type ScreeningCheck } from '@prisma/client';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { invalidState, notFound } from '@/lib/errors';
import {
  deriveFlags,
  extractClaims,
  FLAG_LABELS,
  highestSeverity,
  findCopies,
  summariseSuggestions,
  type EvidenceRow,
  type Flag,
  type PeerSubmission,
} from '@/server/domain/screening-signals';
import {
  evidenceConfig,
  evidenceLookupFor,
  type EvidenceLookup,
} from '@/server/integrations/evidence';
import { type Actor, recordActivity } from './activity';
import { raiseAttention, resolveIfPresent } from './attention';
import { enqueueJob } from './jobs';
import { scorerFor, screeningCheckConfig, type ScreeningScorer } from './screening-scorer';
import { estimateCostMicros } from './task-solver';

/**
 * Checking a screening submission before a reviewer reads it.
 *
 * Three things, all advisory:
 *
 *  1. Suggested scores per rubric criterion, from a model (or the simulated
 *     scorer). Withheld from a reviewer until they submit their own.
 *  2. Evidence: GitHub accounts and repositories and CVE ids the candidate
 *     cites, looked up; bar admissions listed for a manual check, because no
 *     public API covers them and pretending otherwise would be worse.
 *  3. Integrity flags: copied answers, a GitHub account another candidate also
 *     claims, a brand-new account, citations that do not exist, text aimed at
 *     an automated grader.
 *
 * Flags raise one attention item per screening. Nothing here changes the
 * screening's status or any decision.
 */

/** How far back to look for copied answers and shared accounts. */
const PEER_LOOKBACK_DAYS = 365;
const PEER_LIMIT = 500;

function linksOf(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function answersOf(value: Prisma.JsonValue): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function githubLoginsOf(answers: Record<string, string>, links: string[]): string[] {
  return [...new Set(extractClaims(answers, links).github.map((ref) => ref.login))];
}

export interface RunScreeningCheckOptions {
  now?: Date;
  scorer?: ScreeningScorer;
  lookup?: EvidenceLookup;
}

export async function runScreeningCheck(
  db: Db,
  submissionId: string,
  options: RunScreeningCheckOptions = {},
): Promise<{ status: 'COMPLETE' | 'FAILED' | 'SKIPPED'; flags: number; checkId?: string }> {
  const at = options.now ?? clockNow();
  const submission = await db.screeningSubmission.findUnique({
    where: { id: submissionId },
    include: {
      screening: {
        include: {
          candidate: true,
          rubricVersion: {
            include: { criteria: { orderBy: { position: 'asc' } }, template: true },
          },
        },
      },
    },
  });
  if (!submission) return { status: 'SKIPPED', flags: 0 };
  const { screening } = submission;
  const rubric = screening.rubricVersion;
  const answers = answersOf(submission.answers);
  const links = linksOf(submission.workSampleLinks);

  const scorer = options.scorer ?? scorerFor(screeningCheckConfig());
  const lookup =
    options.lookup ?? evidenceLookupFor(evidenceConfig(), () => options.now ?? clockNow());

  // --- Suggested scores -----------------------------------------------------
  const criteria = rubric.criteria.map((c) => ({
    key: c.key,
    label: c.label,
    scoringGuidance: c.scoringGuidance,
    maxScore: c.maxScore,
    weight: c.weight,
    isGating: c.isGating,
  }));
  const scoring = await scorer.score({
    rubricName: rubric.template.name,
    guidance: rubric.guidance,
    criteria,
    answers,
  });
  const summary = scoring.error
    ? null
    : summariseSuggestions(criteria, answers, scoring.suggestions, rubric.passThreshold);

  // --- Evidence -------------------------------------------------------------
  const claims = extractClaims(answers, links);
  const evidence: EvidenceRow[] = [];
  for (const ref of claims.github) evidence.push(...(await lookup.github(ref)));
  for (const id of claims.cves) evidence.push(await lookup.cve(id));
  for (const claim of claims.barClaims) {
    evidence.push({
      kind: 'BAR_ADMISSION',
      subject: claim,
      status: 'MANUAL',
      detail:
        "Check this on the admitting state bar's public lookup. No API covers every state, so it is not checked automatically.",
      url: null,
    });
  }

  // --- Peers: other candidates on the same screening template --------------
  const peerRows = await db.screeningSubmission.findMany({
    where: {
      id: { not: submission.id },
      submittedAt: { gte: new Date(at.getTime() - PEER_LOOKBACK_DAYS * 86_400_000) },
      screening: {
        candidateId: { not: screening.candidateId },
        rubricVersion: { templateId: rubric.templateId },
      },
    },
    orderBy: { submittedAt: 'desc' },
    take: PEER_LIMIT,
    include: { screening: { select: { reference: true, candidateId: true } } },
  });
  const peers: PeerSubmission[] = peerRows.map((row) => {
    const peerAnswers = answersOf(row.answers);
    return {
      screeningReference: row.screening.reference,
      candidateId: row.screening.candidateId,
      answers: peerAnswers,
      githubLogins: githubLoginsOf(peerAnswers, linksOf(row.workSampleLinks)),
    };
  });

  // Shared accounts are checked across every template: a GitHub account two
  // people present as their own is suspicious whatever they applied for.
  const myLogins = new Set(claims.github.map((ref) => ref.login));
  const sharedLogins = new Map<string, string[]>();
  if (myLogins.size > 0) {
    const otherRows = await db.screeningSubmission.findMany({
      where: {
        submittedAt: { gte: new Date(at.getTime() - PEER_LOOKBACK_DAYS * 86_400_000) },
        screening: { candidateId: { not: screening.candidateId } },
      },
      orderBy: { submittedAt: 'desc' },
      take: PEER_LIMIT,
      select: {
        answers: true,
        workSampleLinks: true,
        screening: { select: { reference: true } },
      },
    });
    for (const row of otherRows) {
      for (const login of githubLoginsOf(answersOf(row.answers), linksOf(row.workSampleLinks))) {
        if (!myLogins.has(login)) continue;
        const refs = sharedLogins.get(login) ?? [];
        if (!refs.includes(row.screening.reference)) refs.push(row.screening.reference);
        sharedLogins.set(login, refs.slice(0, 5));
      }
    }
  }

  const flags = deriveFlags({
    candidateId: screening.candidateId,
    answers,
    evidence,
    copies: findCopies(screening.candidateId, answers, peers),
    sharedLogins,
    startedAt:
      submission.revision > 1 && screening.revisionRequestedAt
        ? screening.revisionRequestedAt
        : screening.invitedAt,
    submittedAt: submission.submittedAt,
    checkedAt: at,
  });

  const data = {
    screeningId: screening.id,
    status: scoring.error ? ('FAILED' as const) : ('COMPLETE' as const),
    scorerProvider: scorer.provider,
    scorerModel: scorer.model,
    suggestedScores: (summary?.scores ?? []) as unknown as Prisma.InputJsonValue,
    suggestedTotal: summary?.total ?? null,
    maxTotal: summary?.maxTotal ?? null,
    suggestedPass: summary?.pass ?? null,
    summary: scoring.summary,
    evidenceMode: lookup.mode,
    evidence: evidence as unknown as Prisma.InputJsonValue,
    flags: flags as unknown as Prisma.InputJsonValue,
    inputTokens: scoring.inputTokens,
    outputTokens: scoring.outputTokens,
    costMicros:
      scorer.provider === 'anthropic'
        ? estimateCostMicros(scorer.model, scoring.inputTokens, scoring.outputTokens)
        : null,
    error: scoring.error,
    checkedAt: at,
  };
  const check = await db.screeningCheck.upsert({
    where: { submissionId: submission.id },
    create: { submissionId: submission.id, ...data },
    update: data,
  });

  await syncIntegrityAttention(db, screening, submission.revision, flags, at);

  await recordActivity(db, {
    actor: { type: 'SYSTEM', label: 'Screening checks' },
    entityType: 'screening',
    entityId: screening.id,
    candidateId: screening.candidateId,
    action: 'screening.checked',
    summary: flags.length
      ? `Checks on ${screening.reference} revision ${submission.revision} raised ${flags.length} flag(s): ${[...new Set(flags.map((f) => FLAG_LABELS[f.code].toLowerCase()))].join('; ')}`
      : `Checks on ${screening.reference} revision ${submission.revision} raised no flags`,
    metadata: {
      submissionId: submission.id,
      scorer: scorer.provider,
      evidenceMode: lookup.mode,
      evidence: evidence.length,
      flags: flags.map((f) => f.code),
      scoringError: scoring.error,
    },
  });

  return { status: data.status, flags: flags.length, checkId: check.id };
}

async function syncIntegrityAttention(
  db: Db,
  screening: {
    id: string;
    reference: string;
    candidateId: string;
    candidate: { fullName: string };
  },
  revision: number,
  flags: Flag[],
  at: Date,
) {
  const dedupeKey = `screening:integrity:${screening.id}`;
  const serious = flags.filter((f) => f.severity !== 'LOW');
  if (serious.length === 0) {
    await resolveIfPresent(db, dedupeKey, `Revision ${revision} raised no integrity flags.`, {
      now: at,
    });
    return;
  }
  await raiseAttention(
    db,
    {
      dedupeKey,
      category: 'screening.integrity',
      severity: highestSeverity(serious) ?? 'MEDIUM',
      title: `${screening.reference} (${screening.candidate.fullName}): ${FLAG_LABELS[serious[0]!.code].toLowerCase()}${serious.length > 1 ? ` and ${serious.length - 1} more` : ''}`,
      blocker: serious[0]!.detail,
      impact: 'A reviewer could approve someone whose evidence is not theirs.',
      nextAction:
        'Open the screening, read the flags next to the answers, and decide whether to ask the candidate about them.',
      candidateId: screening.candidateId,
      screeningId: screening.id,
      metadata: { revision, flags: serious.map((f) => f.code) },
    },
    { now: at },
  );
}

/** HUMAN ACTION. Check the latest submission again, e.g. after a rate limit. */
export async function requestScreeningRecheck(db: Db, actor: Actor, screeningId: string) {
  const latest = await db.screeningSubmission.findFirst({
    where: { screeningId },
    orderBy: { revision: 'desc' },
    include: { screening: true },
  });
  if (!latest) throw notFound('This screening has no submission to check.');
  if (latest.screening.status === 'WITHDRAWN') {
    throw invalidState('A withdrawn screening is not checked.');
  }
  const at = clockNow();
  const { job, deduplicated } = await enqueueJob(db, {
    type: 'screening.check_submission',
    payload: { submissionId: latest.id },
    priority: 30,
    dedupeKey: `screening.check_submission:${latest.id}:rerun:${Math.floor(at.getTime() / 60_000)}`,
    dedupeScope: 'DISPOSABLE',
  });
  if (!deduplicated) {
    await recordActivity(db, {
      actor,
      entityType: 'screening',
      entityId: screeningId,
      candidateId: latest.screening.candidateId,
      action: 'screening.recheck_requested',
      summary: `${actor.label} asked for ${latest.screening.reference} to be checked again`,
    });
  }
  return { queued: !deduplicated, jobId: job?.id ?? null };
}

// ---------------------------------------------------------------------------
// What a viewer may see
// ---------------------------------------------------------------------------

export type ScreeningCheckView = Omit<
  ScreeningCheck,
  'suggestedScores' | 'suggestedTotal' | 'suggestedPass' | 'summary'
> & {
  suggestedScores: Prisma.JsonValue;
  suggestedTotal: number | null;
  suggestedPass: boolean | null;
  summary: string;
  /** True when suggestions exist but are hidden from this viewer for now. */
  suggestionsWithheld: boolean;
};

/**
 * Withhold suggested scores from a reviewer who has not scored yet.
 *
 * Seeing a model's number first anchors a reviewer to it, and then two
 * opinions become one. Evidence and flags are facts to check, not opinions,
 * so they are always shown. Anyone who is not an assigned reviewer with a
 * pending review sees everything.
 */
export function viewCheckFor(
  check: ScreeningCheck,
  reviews: Array<{ reviewerId: string; state: string }>,
  viewerUserId: string | null,
): ScreeningCheckView {
  const pending = reviews.some((r) => r.reviewerId === viewerUserId && r.state === 'ASSIGNED');
  if (!pending) return { ...check, suggestionsWithheld: false };
  return {
    ...check,
    suggestedScores: [],
    suggestedTotal: null,
    suggestedPass: null,
    summary: '',
    suggestionsWithheld: true,
  };
}

/** The latest submission's check for a screening, shaped for this viewer. */
export async function checkForScreening(db: Db, screeningId: string, viewerUserId: string | null) {
  const latest = await db.screeningSubmission.findFirst({
    where: { screeningId },
    orderBy: { revision: 'desc' },
    include: { check: true },
  });
  if (!latest?.check) return null;
  const reviews = await db.screeningReview.findMany({
    where: { screeningId },
    select: { reviewerId: true, state: true },
  });
  return { revision: latest.revision, ...viewCheckFor(latest.check, reviews, viewerUserId) };
}
