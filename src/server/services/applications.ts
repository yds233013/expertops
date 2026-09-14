import { type Application, type Prisma } from '@prisma/client';
import { type Db, type MaybeTransactor, withTransaction } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { AppError, badRequest, invalidState, notFound } from '@/lib/errors';
import { type Actor, candidateActor, recordActivity, SYSTEM_ACTOR } from './activity';
import { acceptanceState, type OpportunityQuestion } from './opportunities';

/**
 * Applying to an opportunity, without an operator typing anything first.
 *
 * Four things this has to get right, and each of them is a way the naive
 * version goes wrong:
 *
 *  * **Identity.** The same person applying to a second opportunity is the same
 *    person, matched on their email address. A new candidate row per
 *    application would fragment their history and defeat duplicate detection.
 *  * **Duplicates.** A double-clicked submit, or a refreshed confirmation page,
 *    must find the application it already made. The unique index on
 *    `(opportunityId, candidateId)` is what guarantees it; this code cooperates
 *    with it rather than relying on a prior read.
 *  * **History.** The opportunity is copied into the application at submission.
 *    An operator editing the questions next week must not change what somebody
 *    answered last week.
 *  * **Acceptance.** Draft and closed and expired are refused here, in the
 *    service, so it holds no matter which route or page calls it.
 */
const MAX_ANSWER_LENGTH = 4000;
const MAX_EXPERIENCE_LENGTH = 5000;
const MAX_SKILLS = 20;
const MAX_LINKS = 5;

/** How many applications one address, or one client, may make in a window. */
export const APPLICATION_WINDOW_MINUTES = 60;
export const APPLICATION_LIMIT_PER_EMAIL = 5;
export const APPLICATION_LIMIT_PER_IP = 20;

export interface ApplyInput {
  opportunitySlug: string;
  fullName: string;
  email: string;
  experience: string;
  skills?: string[];
  weeklyHours?: number | null;
  answers?: Record<string, string>;
  workSampleLinks?: string[];
  clientIp?: string | null;
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normaliseSkills(input: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input ?? []) {
    const name = raw.trim().slice(0, 80);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_SKILLS) break;
  }
  return out;
}

function normaliseLinks(input: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of input ?? []) {
    const link = raw.trim();
    if (!link) continue;
    if (!/^https?:\/\//i.test(link)) {
      throw badRequest('A work sample link must start with http:// or https://.');
    }
    out.push(link.slice(0, 500));
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

async function nextApplicationReference(db: Db): Promise<string> {
  const rows = await db.application.findMany({
    where: { reference: { startsWith: 'APP-' } },
    select: { reference: true },
  });
  let highest = 0;
  for (const row of rows) {
    const match = /^APP-(\d+)$/.exec(row.reference);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `APP-${String(highest + 1).padStart(4, '0')}`;
}

async function nextCandidateReference(db: Db): Promise<string> {
  const rows = await db.candidate.findMany({
    where: { reference: { startsWith: 'CAN-' } },
    select: { reference: true },
  });
  let highest = 0;
  for (const row of rows) {
    const match = /^CAN-(\d+)$/.exec(row.reference);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `CAN-${String(highest + 1).padStart(4, '0')}`;
}

/**
 * Bounded abuse protection, reusing the same table the sign-in throttle uses.
 *
 * Deliberately generous: this is a staging exercise behind a gate, and the cost
 * of a false positive — a real applicant told to come back later — is higher
 * than the cost of a few extra synthetic rows.
 */
async function assertWithinLimits(db: Db, email: string, clientIp: string | null | undefined) {
  const since = new Date(clockNow().getTime() - APPLICATION_WINDOW_MINUTES * 60_000);
  const [byEmail, byIp] = await Promise.all([
    db.application.count({ where: { candidate: { email }, submittedAt: { gte: since } } }),
    clientIp
      ? db.loginAttempt.count({
          where: { clientIp, email: `application:${clientIp}`, createdAt: { gte: since } },
        })
      : Promise.resolve(0),
  ]);
  if (byEmail >= APPLICATION_LIMIT_PER_EMAIL || byIp >= APPLICATION_LIMIT_PER_IP) {
    throw new AppError(
      'RATE_LIMITED',
      'That is a lot of applications in a short time. Try again in about an hour.',
      { retryAfterSeconds: APPLICATION_WINDOW_MINUTES * 60 },
    );
  }
}

export interface ApplyResult {
  application: Application;
  /** False when this submission matched one that already existed. */
  created: boolean;
  candidateReference: string;
}

export async function applyToOpportunity(
  db: MaybeTransactor,
  input: ApplyInput,
): Promise<ApplyResult> {
  const fullName = input.fullName.trim();
  const email = normaliseEmail(input.email);
  const experience = input.experience.trim().slice(0, MAX_EXPERIENCE_LENGTH);

  if (fullName.length < 2) throw badRequest('Please give the name you go by.');
  if (!validEmail(email)) throw badRequest('That does not look like an email address.');
  if (!experience) throw badRequest('Please describe your relevant experience.');
  if (input.weeklyHours != null && (input.weeklyHours < 1 || input.weeklyHours > 80)) {
    throw badRequest('Weekly availability must be between 1 and 80 hours.');
  }

  const skills = normaliseSkills(input.skills);
  const links = normaliseLinks(input.workSampleLinks);

  return withTransaction(db, async (tx) => {
    const opportunity = await tx.opportunity.findUnique({
      where: { slug: input.opportunitySlug },
      include: { domain: { select: { id: true, name: true } } },
    });
    // A draft is not "closed", it does not exist. Saying so would confirm the
    // slug of something unpublished.
    if (!opportunity || opportunity.status === 'DRAFT') throw notFound('Opportunity not found.');

    const acceptance = acceptanceState(opportunity);
    if (!acceptance.open) throw invalidState(acceptance.reason!);

    const questions = (opportunity.questions as unknown as OpportunityQuestion[]) ?? [];
    const answers: Record<string, string> = {};
    for (const question of questions) {
      const raw = (input.answers ?? {})[question.key] ?? '';
      const value = raw.trim().slice(0, MAX_ANSWER_LENGTH);
      if (question.required && !value) {
        throw badRequest(`Please answer: ${question.label}`);
      }
      if (value) answers[question.key] = value;
    }

    await assertWithinLimits(tx, email, input.clientIp);

    // The same person, not a new one. Matching on the address is what lets
    // somebody apply to a second opportunity without splitting their history.
    let candidate = await tx.candidate.findFirst({ where: { email } });
    let candidateCreated = false;
    if (!candidate) {
      candidate = await tx.candidate.create({
        data: {
          reference: await nextCandidateReference(tx),
          fullName,
          email,
          headline: '',
          stage: 'NEW',
          campaignId: opportunity.campaignId ?? null,
        },
      });
      candidateCreated = true;
    }

    if (candidate.contactOptOutAt) {
      throw invalidState('This address has asked not to be contacted.');
    }

    const existing = await tx.application.findFirst({
      where: { opportunityId: opportunity.id, candidateId: candidate.id },
    });
    if (existing) {
      // A resubmission is not a second application. Withdrawn ones can be
      // reopened, because changing your mind is not an error.
      if (existing.withdrawnAt) {
        const reopened = await tx.application.update({
          where: { id: existing.id },
          data: {
            withdrawnAt: null,
            withdrawReason: null,
            status: 'SUBMITTED',
            submittedAt: clockNow(),
            experience,
            claimedSkills: skills as Prisma.InputJsonValue,
            weeklyHours: input.weeklyHours ?? null,
            answers: answers as Prisma.InputJsonValue,
            workSampleLinks: links as Prisma.InputJsonValue,
          },
        });
        await recordActivity(tx, {
          actor: candidateActor(candidate),
          entityType: 'application',
          entityId: reopened.id,
          candidateId: candidate.id,
          action: 'application.resubmitted',
          summary: `${candidate.fullName} reopened ${reopened.reference} for "${opportunity.title}"`,
        });
        return { application: reopened, created: false, candidateReference: candidate.reference };
      }
      return { application: existing, created: false, candidateReference: candidate.reference };
    }

    const snapshot = {
      capturedAt: clockNow().toISOString(),
      reference: opportunity.reference,
      title: opportunity.title,
      kind: opportunity.kind,
      domainName: opportunity.domain.name,
      requiredSkills: (opportunity.requiredSkills as string[]) ?? [],
      questions: questions as unknown as Prisma.JsonArray,
      applicationDeadline: opportunity.applicationDeadline?.toISOString() ?? null,
      weeklyHoursMin: opportunity.weeklyHoursMin,
      weeklyHoursMax: opportunity.weeklyHoursMax,
    };

    const application = await tx.application.create({
      data: {
        reference: await nextApplicationReference(tx),
        candidateId: candidate.id,
        domainId: opportunity.domainId,
        campaignId: opportunity.campaignId ?? candidate.campaignId ?? null,
        opportunityId: opportunity.id,
        status: 'SUBMITTED',
        experience,
        claimedSkills: skills as Prisma.InputJsonValue,
        weeklyHours: input.weeklyHours ?? null,
        answers: answers as Prisma.InputJsonValue,
        workSampleLinks: links as Prisma.InputJsonValue,
        opportunitySnapshot: snapshot as unknown as Prisma.InputJsonValue,
      },
    });

    const actor: Actor = candidateActor(candidate);
    if (candidateCreated) {
      await recordActivity(tx, {
        actor,
        entityType: 'candidate',
        entityId: candidate.id,
        candidateId: candidate.id,
        action: 'candidate.self_registered',
        summary: `${candidate.fullName} applied and was added to the funnel (${candidate.reference})`,
      });
    }
    await recordActivity(tx, {
      actor,
      entityType: 'application',
      entityId: application.id,
      candidateId: candidate.id,
      action: 'application.submitted',
      summary: `${candidate.fullName} applied to "${opportunity.title}" (${application.reference})`,
      projectId: opportunity.projectId,
      metadata: { opportunityReference: opportunity.reference, linkCount: links.length },
    });

    // Duplicate detection is left to the existing maintenance sweep rather
    // than a bespoke job: an applicant already in the funnel under another
    // address surfaces for a human, and never gets merged automatically.

    return { application, created: true, candidateReference: candidate.reference };
  });
}

/** The applicant's own view of one application. Never anybody else's. */
export async function listApplicationsForCandidate(db: Db, candidateId: string) {
  return db.application.findMany({
    where: { candidateId },
    include: {
      opportunity: { select: { title: true, slug: true, reference: true, status: true } },
    },
    orderBy: { submittedAt: 'desc' },
  });
}

export async function withdrawApplication(
  db: MaybeTransactor,
  candidateId: string,
  applicationId: string,
  reason?: string,
): Promise<Application> {
  return withTransaction(db, async (tx) => {
    const application = await tx.application.findUnique({
      where: { id: applicationId },
      include: { candidate: true, opportunity: { select: { title: true } } },
    });
    if (!application) throw notFound('Application not found.');
    // Scoped to the session's own candidate, so a valid session cannot withdraw
    // somebody else's application by guessing an id.
    if (application.candidateId !== candidateId) throw notFound('Application not found.');
    if (application.withdrawnAt) return application;
    if (application.status === 'CLOSED_QUALIFIED' || application.status === 'CLOSED_REJECTED') {
      throw invalidState('This application has already been decided.');
    }

    const withdrawn = await tx.application.update({
      where: { id: applicationId },
      data: {
        withdrawnAt: clockNow(),
        withdrawReason: reason?.trim().slice(0, 500) || null,
        status: 'CLOSED_WITHDRAWN',
        closedAt: clockNow(),
      },
    });

    await recordActivity(tx, {
      actor: candidateActor(application.candidate),
      entityType: 'application',
      entityId: withdrawn.id,
      candidateId,
      action: 'application.withdrawn',
      summary: `${application.candidate.fullName} withdrew ${withdrawn.reference} from "${application.opportunity?.title ?? 'an opportunity'}"`,
      metadata: { reason: reason?.trim() || null },
    });
    return withdrawn;
  });
}

/** The operator's list for one opportunity. */
export async function listApplicationsForOpportunity(
  db: Db,
  opportunityId: string,
  options: { search?: string; stage?: string } = {},
) {
  const search = options.search?.trim();
  return db.application.findMany({
    where: {
      opportunityId,
      ...(options.stage ? { candidate: { stage: options.stage as never } } : {}),
      ...(search
        ? {
            candidate: {
              OR: [
                { fullName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                { reference: { contains: search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    },
    include: {
      candidate: {
        select: {
          id: true,
          reference: true,
          fullName: true,
          email: true,
          stage: true,
          expertId: true,
        },
      },
    },
    orderBy: { submittedAt: 'desc' },
    take: 200,
  });
}

export async function getApplication(db: Db, applicationId: string) {
  const application = await db.application.findUnique({
    where: { id: applicationId },
    include: {
      candidate: true,
      opportunity: { select: { id: true, reference: true, title: true, slug: true } },
      domain: { select: { id: true, name: true } },
    },
  });
  if (!application) throw notFound('Application not found.');
  return application;
}

/** Marks the application as having a screening under way. */
export async function markScreeningStarted(
  db: MaybeTransactor,
  applicationId: string,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const application = await tx.application.findUnique({ where: { id: applicationId } });
    if (!application || application.status !== 'SUBMITTED') return;
    await tx.application.update({
      where: { id: applicationId },
      data: { status: 'SCREENING_STARTED' },
    });
    await recordActivity(tx, {
      actor: SYSTEM_ACTOR,
      entityType: 'application',
      entityId: applicationId,
      candidateId: application.candidateId,
      action: 'application.screening_started',
      summary: `Screening started for ${application.reference}`,
    });
  });
}

/**
 * Move this candidate's open applications to "screening started".
 *
 * Called when a screening begins, so an applicant's own status page reflects
 * what is happening to them without the operator having to update two things.
 */
export async function markScreeningStartedForCandidate(
  db: MaybeTransactor,
  candidateId: string,
): Promise<number> {
  return withTransaction(db, async (tx) => {
    const open = await tx.application.findMany({
      where: { candidateId, status: 'SUBMITTED', withdrawnAt: null },
      select: { id: true },
    });
    for (const row of open) await markScreeningStarted(tx, row.id);
    return open.length;
  });
}
