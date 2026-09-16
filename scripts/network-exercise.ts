/**
 * The hundred-contributor exercise.
 *
 *   npx tsx scripts/network-exercise.ts
 *
 * Builds a network of 100 synthetic experts across three practice areas and
 * runs it through the whole operational cycle: matching, approved outreach,
 * varied responses, onboarding, verification, thirty confirmed seats, two
 * withdrawals, replacement and restaffing, then work, review and payment
 * preparation up to an exported CSV.
 *
 * Three rules it keeps:
 *
 *  * **Through the services, always.** Nothing here writes a business status
 *    with a raw update. Every transition goes through the same function the
 *    application calls, so every authorisation check, state-machine guard and
 *    audit entry applies exactly as it would to a person clicking.
 *  * **Idempotent.** Each phase asks whether its work is already done before
 *    doing it. Running the script twice leaves one network, not two, and does
 *    not rewind anything already moved on.
 *  * **Honest about who these people are.** The 100 experts are seeded network
 *    members. They are marked as such and none of them is ever made to look
 *    like they applied — applicants arrive through /apply/opportunities and
 *    nowhere else.
 *
 * Every address is @example.test and every record is marked `demoEligible`,
 * which is what identifies a fixture. Display names are deliberately natural:
 * a prefix on every row taught nothing and made the product look like a dump.
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import { parseDatabaseUrl } from '@/lib/database-safety';
import { type Actor } from '@/server/services/activity';
import { createExpert, updateExpert } from '@/server/services/experts';
import { createProject, updateProject, setProjectStatus } from '@/server/services/projects';
import { createOpportunity, publishOpportunity } from '@/server/services/opportunities';
import { declareAvailability } from '@/server/services/availability';
import {
  DOMAIN_RENAMES,
  OPPORTUNITY_RENAMES,
  PROJECT_RENAMES,
  RUBRIC_RENAMES,
  SAMPLE_CLIENT,
  eitherName,
  networkMemberName,
  type Rename,
} from './fixture-names';
import { runMatching } from '@/server/services/matching';
import {
  createBatch as createOutreachBatch,
  buildReplacementBatch,
  submitBatchForApproval as submitOutreachForApproval,
  decideBatch,
  dispatchBatch,
} from '@/server/services/outreach';
import { sendInvitation, respondToInvitation } from '@/server/services/invitations';
import {
  startOnboarding,
  saveChecklistAnswers,
  submitOnboarding,
  decideVerification,
} from '@/server/services/onboarding';
import { proposeAssignment, confirmAssignment } from '@/server/services/staffing';
import { recordWithdrawal, detectStaffingGaps } from '@/server/services/staffing-gaps';
import { createWorkItem, submitWork, reviewWork } from '@/server/services/work';
import {
  draftPaymentFromApprovedWork,
  resolveDiscrepancy,
  createBatch as createPaymentBatch,
  submitBatchForApproval as submitPaymentForApproval,
  approveBatch,
  exportBatch,
} from '@/server/services/payments';
import {
  createTemplate,
  createDraftVersion,
  publishVersion,
  startScreening,
  submitScreening,
  assignReviewer,
  submitReview,
} from '@/server/services/screening';
import { createCandidate } from '@/server/services/candidates';
import { createOperator } from '@/server/services/auth';
import { grantQualification } from '@/server/services/qualifications';

/**
 * Seeded fixtures carry a natural display name and a fixture address.
 *
 * The name used to be "NET Ada Nowak 001", which made every list in the
 * product read as a database dump and taught nobody anything about how it
 * looks in use. Provenance now lives where it belongs: in the address, in the
 * `demoEligible` column, and in one badge on the page.
 */
const FIXTURE_EMAIL_DOMAIN = 'example.test';
const DAY = 24 * 60 * 60 * 1000;

const TIMEZONES = [
  'UTC',
  'Europe/Berlin',
  'Europe/London',
  'America/New_York',
  'America/Sao_Paulo',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Africa/Lagos',
];
/** Operational preference only. Free text, because the model has no field for it. */
const CONTACT = [
  'Prefers email; no calls before 10:00 local.',
  'Prefers a short call before written detail.',
  'Email only. Does not use chat tools.',
  'Async in writing; replies within two working days.',
  'Happy with calls at short notice.',
];

interface AreaSpec {
  key: string;
  slug: string;
  domainName: string;
  project: Rename;
  opportunity: Rename;
  skill: string;
  secondarySkills: string[];
  experts: number;
  seats: number;
  rubric: Rename;
}

const AREAS: AreaSpec[] = [
  {
    key: 'coding',
    slug: 'practice-coding',
    domainName: DOMAIN_RENAMES['practice-coding'].current,
    project: PROJECT_RENAMES.coding,
    opportunity: OPPORTUNITY_RENAMES.coding,
    skill: 'Code Review',
    secondarySkills: ['Static Analysis', 'Refactoring', 'Test Design'],
    experts: 40,
    seats: 12,
    rubric: RUBRIC_RENAMES.coding,
  },
  {
    key: 'enterprise',
    slug: 'practice-enterprise-business',
    domainName: DOMAIN_RENAMES['practice-enterprise-business'].current,
    project: PROJECT_RENAMES.enterprise,
    opportunity: OPPORTUNITY_RENAMES.enterprise,
    skill: 'Process Analysis',
    secondarySkills: ['Stakeholder Interviewing', 'Cost Modelling', 'Change Management'],
    experts: 35,
    seats: 10,
    rubric: RUBRIC_RENAMES.enterprise,
  },
  {
    key: 'cyber',
    slug: 'practice-cybersecurity',
    domainName: DOMAIN_RENAMES['practice-cybersecurity'].current,
    project: PROJECT_RENAMES.cyber,
    opportunity: OPPORTUNITY_RENAMES.cyber,
    skill: 'Threat Modelling',
    secondarySkills: ['Incident Response', 'Cloud Security', 'Risk Ranking'],
    experts: 25,
    seats: 8,
    rubric: RUBRIC_RENAMES.cyber,
  },
];

const MIN_YEARS = 3;
const RATE_CEILING_CENTS = 25_000;

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/**
 * Mark a seeded record as showable in the anonymous demo.
 *
 * Deliberately a direct write and deliberately only here: eligibility is a
 * statement about where a record came from, and only the thing that created it
 * can make that statement. Nothing reachable over HTTP sets this.
 */
async function markDemoEligible(expertId: string) {
  await prisma.expert.update({ where: { id: expertId }, data: { demoEligible: true } });
}

const log: string[] = [];
function say(line = '') {
  console.log(line);
  log.push(line);
}

/**
 * What each seeded expert looks like.
 *
 * Deliberately uneven. A network where everybody qualifies proves nothing: the
 * exclusions are the part worth looking at, so a quarter of each area is built
 * to fail a hard filter, and a fifth never declares availability.
 */
interface Seeded {
  index: number;
  area: AreaSpec;
  fullName: string;
  email: string;
  yearsExperience: number;
  hourlyRateCents: number;
  timezone: string;
  weeklyCapacityHours: number;
  proficiency: number;
  secondary: { name: string; proficiency: number; yearsUsed: number }[];
  contact: string;
  hasAvailability: boolean;
  /** A window on another project, so capacity is visibly already spoken for. */
  overlappingCommitment: boolean;
  /**
   * True for the people who joined the way the product intends — screened as a
   * candidate, qualified by a person, converted to an expert by that decision.
   * The rest were entered directly by an operator, which is the other supported
   * route. Neither group applied to an opportunity.
   */
  joinsByScreening: boolean;
}

function planExperts(): Seeded[] {
  const plan: Seeded[] = [];
  let serial = 0;
  for (const area of AREAS) {
    for (let i = 0; i < area.experts; i += 1) {
      serial += 1;
      const serialText = String(serial).padStart(3, '0');
      // The first three-quarters clear every hard filter; the rest are built to
      // be excluded, one reason at a time, so the run shows each of them.
      const strong = i < Math.floor(area.experts * 0.75);
      const proficiency = strong ? 3 + (i % 3) : 1 + (i % 2);
      plan.push({
        index: i,
        area,
        fullName: networkMemberName(serial),
        email: `net.${area.key}.${serialText}@${FIXTURE_EMAIL_DOMAIN}`,
        yearsExperience: strong ? MIN_YEARS + (i % 14) : 1 + (i % 2),
        hourlyRateCents: 9_000 + ((i * 1700) % 22_000),
        timezone: TIMEZONES[i % TIMEZONES.length] ?? 'UTC',
        weeklyCapacityHours: 10 + ((i * 5) % 30),
        proficiency,
        secondary: area.secondarySkills
          .slice(0, 1 + (i % area.secondarySkills.length))
          .map((name, position) => ({
            name,
            proficiency: 1 + ((i + position) % 5),
            yearsUsed: (i + position) % 9,
          })),
        contact: CONTACT[i % CONTACT.length] ?? CONTACT[0]!,
        hasAvailability: i % 5 !== 4,
        overlappingCommitment: i % 7 === 3,
        joinsByScreening: strong && i % 4 === 0,
      });
    }
  }
  return plan;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) fail('DATABASE_URL is not set.');
  const target = parseDatabaseUrl(url);
  if (target.kind === 'development') {
    fail(
      `Refusing to run on the development database ("${target.name}"). ` +
        'Point DATABASE_URL at an isolated exercise database or a deployment.',
    );
  }

  /**
   * Accounts for the exercise, named rather than guessed at.
   *
   * On a deployment the oldest ADMIN is a real person's account, and running a
   * hundred people through the pipeline under their name would put several
   * hundred synthetic actions into their audit history. So the three identities
   * are looked up by address, and created if a password is supplied for them.
   *
   * A password is read from the environment and never printed. Set the
   * variables for one deploy, then remove them — the same handling the first
   * operator gets in `bootstrap-operator.ts`.
   */
  const WANTED = [
    {
      key: 'lead' as const,
      email: process.env.EXERCISE_LEAD_EMAIL ?? 'exercise.lead@example.test',
      name: 'Exercise Lead',
      role: 'ADMIN' as const,
      password: process.env.EXERCISE_LEAD_PASSWORD,
    },
    {
      key: 'approver' as const,
      email: process.env.EXERCISE_APPROVER_EMAIL ?? 'exercise.approver@example.test',
      name: 'Exercise Approver',
      role: 'ADMIN' as const,
      password: process.env.EXERCISE_APPROVER_PASSWORD,
    },
    {
      key: 'coordinator' as const,
      email: process.env.EXERCISE_COORDINATOR_EMAIL ?? 'exercise.coordinator@example.test',
      name: 'Exercise Coordinator',
      role: 'OPERATOR' as const,
      password: process.env.EXERCISE_COORDINATOR_PASSWORD,
    },
  ];

  const asActor = (user: { id: string; name: string; email: string }): Actor => ({
    type: 'OPERATOR',
    userId: user.id,
    label: `${user.name} <${user.email}>`,
  });

  const accounts: Record<string, { id: string; name: string; email: string }> = {};
  for (const wanted of WANTED) {
    let user = await prisma.user.findUnique({ where: { email: wanted.email } });
    if (!user && wanted.password) {
      user = await createOperator(prisma, {
        email: wanted.email,
        name: wanted.name,
        role: wanted.role,
        password: wanted.password,
      });
      say(`  created the ${wanted.key} account ${wanted.email} (${wanted.role})`);
    }
    if (!user) {
      fail(
        `No account ${wanted.email}. Create it with scripts/create-operator.ts, or supply ` +
          `EXERCISE_${wanted.key.toUpperCase()}_PASSWORD for one run so this can create it.`,
      );
    }
    accounts[wanted.key] = user;
  }

  const lead = asActor(accounts.lead!);
  const approver = asActor(accounts.approver!);
  const coordinator = asActor(accounts.coordinator!);
  const leadUserId = accounts.lead!.id;

  say(`\n  Network exercise on ${target.redactedUrl}`);
  say(`    lead        ${lead.label}`);
  say(`    approver    ${approver.label}`);
  say(`    coordinator ${coordinator.label}`);

  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  async function phase<T>(name: string, run: () => Promise<T>): Promise<T> {
    const began = Date.now();
    const result = await run();
    timings[name] = Date.now() - began;
    return result;
  }

  // --- 1. areas ------------------------------------------------------------
  const areaIds = await phase('areas', async () => {
    const ids: Record<string, { domainId: string; projectId: string; rubricVersionId: string }> =
      {};
    for (const area of AREAS) {
      let domain = await prisma.domain.findUnique({ where: { slug: area.slug } });
      if (!domain) {
        domain = await prisma.domain.create({
          data: {
            slug: area.slug,
            name: area.domainName,
            description: 'Practice area. Not a real field of work.',
          },
        });
      }

      let project = await prisma.project.findFirst({ where: { title: eitherName(area.project) } });
      if (!project) {
        project = await createProject(prisma, lead, {
          title: area.project.current,
          clientName: SAMPLE_CLIENT,
          description: 'Practice project. No real client and no real work.',
          seatsRequested: area.seats,
          minYearsExperience: MIN_YEARS,
          maxHourlyRateCents: RATE_CEILING_CENTS,
          requirements: [{ skillName: area.skill, required: true, minProficiency: 3 }],
        });
      } else if (project.seatsRequested !== area.seats) {
        project = await updateProject(prisma, lead, project.id, { seatsRequested: area.seats });
      }
      await prisma.project.update({ where: { id: project.id }, data: { demoEligible: true } });

      // The opportunity people apply to. Created by the earlier practice script
      // on a deployment; created here when the database is fresh.
      const existingOpportunity = await prisma.opportunity.findFirst({
        where: { title: eitherName(area.opportunity) },
      });
      if (!existingOpportunity) {
        const opportunity = await createOpportunity(prisma, lead, {
          title: area.opportunity.current,
          kind: 'PROJECT_ENGAGEMENT',
          domainId: domain.id,
          projectId: project.id,
          summary: `Practice listing for ${area.domainName}.`,
          description: 'A practice engagement. Nothing here is real client work.',
          responsibilities: 'Read the brief.\nWrite up what you find.\nSay what you would not do.',
          requiredSkills: [area.skill],
          weeklyHoursMin: 8,
          weeklyHoursMax: 16,
          applicationDeadline: new Date(Date.now() + 30 * DAY),
          compensationNote: 'Practice listing — no compensation is offered or implied.',
          internalNotes: 'Sample record. Client identity would live here, never on the listing.',
          questions: [
            {
              key: 'relevant-work',
              label: 'Describe the closest work you have done.',
              required: true,
            },
            {
              key: 'availability-note',
              label: 'Anything about your availability?',
              required: false,
            },
          ],
        });
        await publishOpportunity(prisma, lead, opportunity.id);
      }

      // One published rubric per area, so qualifications have something real to
      // be granted against.
      let template = await prisma.screeningTemplate.findFirst({
        where: { name: eitherName(area.rubric) },
      });
      if (!template) {
        template = await createTemplate(prisma, lead, {
          name: area.rubric.current,
          domainId: domain.id,
          description: 'Practice rubric for the network exercise.',
        });
        const draft = await createDraftVersion(prisma, lead, {
          templateId: template.id,
          guidance: 'Score what the person actually did, not what they say they know.',
          changeNote: 'First version, created by the network exercise.',
          criteria: [
            {
              key: 'depth',
              label: 'Practical depth',
              scoringGuidance: 'Specifics of work they did themselves.',
              requiredEvidence: 'WRITTEN_ANSWER',
            },
            {
              key: 'judgement',
              label: 'Judgement under constraint',
              scoringGuidance: 'What they chose not to do, and why.',
              requiredEvidence: 'WRITTEN_ANSWER',
            },
          ],
        });
        await publishVersion(prisma, lead, draft.id);
      }
      const version = await prisma.screeningRubricVersion.findFirst({
        where: { templateId: template.id, status: 'PUBLISHED' },
        orderBy: { version: 'desc' },
      });
      if (!version) fail(`${area.rubric.current} has no published version.`);

      ids[area.key] = {
        domainId: domain.id,
        projectId: project.id,
        rubricVersionId: version.id,
      };
    }
    return ids;
  });

  // --- 2. the hundred, by the two routes into the network -------------------
  const planned = planExperts();
  const expertIdByEmail = new Map<string, string>();

  const intake = await phase('intake', async () => {
    let entered = 0;
    let screened = 0;

    for (const person of planned) {
      const existing = await prisma.expert.findUnique({ where: { email: person.email } });
      if (existing) {
        expertIdByEmail.set(person.email, existing.id);
        continue;
      }

      const profile = {
        headline: `Network member — ${person.area.domainName}`,
        bio: 'Synthetic record created for the network exercise. Not a real person.',
        yearsExperience: person.yearsExperience,
        timezone: person.timezone,
        hourlyRateCents: person.hourlyRateCents,
        weeklyCapacityHours: person.weeklyCapacityHours,
        notes: `Contact preference: ${person.contact} Joined as a network member; did not apply to an opportunity.`,
        skills: [
          {
            name: person.area.skill,
            proficiency: person.proficiency,
            yearsUsed: person.index % 12,
          },
          ...person.secondary,
        ],
      };

      if (!person.joinsByScreening) {
        // Route one: an operator enters somebody they already know of.
        const expert = await createExpert(prisma, lead, {
          fullName: person.fullName,
          email: person.email,
          ...profile,
        });
        expertIdByEmail.set(person.email, expert.id);
        entered += 1;
        continue;
      }

      // Route two: screened, then qualified by a person. The qualification is
      // what creates the expert record — nobody joins as a side effect of
      // filling in a form.
      let candidate = await prisma.candidate.findFirst({ where: { email: person.email } });
      if (!candidate) {
        const result = await createCandidate(prisma, lead, {
          fullName: person.fullName,
          email: person.email,
          headline: profile.headline,
          yearsExperience: person.yearsExperience,
          notes: 'Entered by an operator for assessment. Did not apply to an opportunity.',
        });
        candidate = result.candidate;
      }

      let screening = await prisma.screening.findFirst({ where: { candidateId: candidate.id } });
      if (!screening) {
        screening = await startScreening(prisma, lead, {
          candidateId: candidate.id,
          rubricVersionId: areaIds[person.area.key]!.rubricVersionId,
          dueInHours: 168,
        });
      }
      const submissions = await prisma.screeningSubmission.count({
        where: { screeningId: screening.id },
      });
      if (submissions === 0) {
        await submitScreening(
          prisma,
          { type: 'CANDIDATE', label: person.fullName },
          {
            screeningId: screening.id,
            answers: {
              depth: `Led ${2 + (person.index % 5)} pieces of ${person.area.domainName} work and wrote the findings up myself.`,
              judgement:
                'Dropped a low-impact finding rather than pad the report, and said so explicitly.',
            },
            note: 'Seeded submission for the network exercise.',
          },
        );
      }
      let review = await prisma.screeningReview.findFirst({
        where: { screeningId: screening.id },
      });
      if (!review) {
        review = await assignReviewer(prisma, lead, {
          screeningId: screening.id,
          reviewerId: leadUserId,
        });
      }
      if (review.state === 'ASSIGNED') {
        await submitReview(prisma, lead, {
          reviewId: review.id,
          decision: 'APPROVE',
          scores: { depth: 4, judgement: 4 },
          publicFeedback: 'Specific about work you did yourself. Good.',
          privateNotes: 'Seeded review. Not a judgement about a real person.',
        });
      }
      const granted = await grantQualification(prisma, lead, {
        screeningId: screening.id,
        note: 'HUMAN DECISION: qualified on the seeded screening for the network exercise.',
      });
      // The conversion carries name, email and headline. The rest of the
      // profile is what an operator would fill in next.
      await updateExpert(prisma, lead, granted.expertId, profile);
      await markDemoEligible(granted.expertId);
      expertIdByEmail.set(person.email, granted.expertId);
      screened += 1;
    }
    return { entered, screened };
  });

  // --- 3. availability -----------------------------------------------------
  const windows = await phase('availability', async () => {
    let added = 0;
    for (const person of planned) {
      if (!person.hasAvailability) continue;
      const expertId = expertIdByEmail.get(person.email)!;
      const existing = await prisma.availabilityWindow.count({ where: { expertId } });
      if (existing > 0) continue;
      const start = new Date(Date.now() - 1 * DAY);
      await declareAvailability(prisma, lead, expertId, {
        startAt: start,
        endAt: new Date(start.getTime() + 150 * DAY),
        hoursPerWeek: Math.min(person.weeklyCapacityHours, 40),
        note: 'Declared availability',
      });
      added += 1;
    }
    return added;
  });

  const qualifications = await prisma.qualification.count();

  say(`\n  1-3  network built`);
  say(`       entered directly by an operator   ${intake.entered}`);
  say(`       screened, then qualified into it  ${intake.screened}`);
  say(`       availability windows added        ${windows}`);
  say(`       qualifications on file            ${qualifications}`);

  // --- 5. matching ---------------------------------------------------------
  const matching = await phase('matching', async () => {
    const rows: { area: string; ranked: number; excluded: number; reasons: string[] }[] = [];
    for (const area of AREAS) {
      const projectId = areaIds[area.key]!.projectId;
      let project = await prisma.project.findUnique({ where: { id: projectId } });
      if (project && project.status === 'DRAFT') {
        project = await setProjectStatus(prisma, lead, projectId, 'MATCHING', {
          reason: 'Network exercise: open for matching',
        });
      }
      // A project that is already full is ACTIVE, and matching is not offered
      // for one — correctly, since there is no seat to match against. On a
      // re-run that is the normal state, not a failure.
      if (!project || !['MATCHING', 'INVITING', 'STAFFING'].includes(project.status)) {
        rows.push({
          area: area.domainName,
          ranked: 0,
          excluded: 0,
          reasons: [`${project?.status ?? 'missing'} — matching not offered`],
        });
        continue;
      }
      const run = await runMatching(prisma, lead, projectId, {
        limit: 100,
        includeExcluded: true,
      });
      const candidates = await prisma.matchCandidate.findMany({
        where: { matchRunId: run.id },
        select: { excluded: true, exclusionReason: true },
      });
      const reasons = new Set<string>();
      for (const candidate of candidates) {
        if (candidate.excluded && candidate.exclusionReason) {
          reasons.add(candidate.exclusionReason.replace(/\(.*\)/, '').trim());
        }
      }
      rows.push({
        area: area.domainName,
        ranked: candidates.filter((candidate) => !candidate.excluded).length,
        excluded: candidates.filter((candidate) => candidate.excluded).length,
        reasons: [...reasons],
      });
    }
    return rows;
  });

  say(`\n  5    matching`);
  for (const row of matching) {
    say(`       ${row.area}: ${row.ranked} ranked, ${row.excluded} excluded`);
    for (const reason of row.reasons) say(`         excluded because — ${reason}`);
  }

  // --- 6. approved outreach, and varied responses ---------------------------
  const outreach = await phase('outreach', async () => {
    const rows: {
      area: string;
      invited: number;
      accepted: number;
      declined: number;
      noResponse: number;
      batch: string;
    }[] = [];

    for (const area of AREAS) {
      const projectId = areaIds[area.key]!.projectId;
      const alreadyInvited = await prisma.invitation.count({ where: { projectId } });
      let batchReference = '(existing)';

      if (alreadyInvited === 0) {
        const run = await prisma.matchRun.findFirst({
          where: { projectId },
          orderBy: { createdAt: 'desc' },
        });
        if (!run) fail(`No match run for ${area.project.current}.`);
        const shortlist = await prisma.matchCandidate.findMany({
          where: { matchRunId: run.id, excluded: false },
          orderBy: { score: 'desc' },
          take: area.seats + 8,
        });
        if (shortlist.length < area.seats) {
          fail(
            `${area.project.current} has only ${shortlist.length} eligible experts for ${area.seats} seats.`,
          );
        }

        const batch = await createOutreachBatch(prisma, coordinator, {
          kind: 'REPLACEMENT',
          projectId,
          reason: `Network exercise: staffing ${area.project.current}`,
          items: shortlist.map((candidate) => ({
            expertId: candidate.expertId,
            rationale: 'Top of the ranking and clears every hard filter.',
            matchScore: candidate.score,
          })),
        });
        await submitOutreachForApproval(prisma, coordinator, batch.id);
        // Bigger than the self-approval limit, so a second identity must decide.
        await decideBatch(prisma, approver, {
          batchId: batch.id,
          approve: true,
          note: 'Network exercise: approved by a different account than the creator.',
        });
        await dispatchBatch(prisma, approver, batch.id, {
          message: `You are invited to ${area.project.current}.`,
        });
        batchReference = batch.reference;
      }

      // The worker would send these; the script sends them itself so the
      // exercise does not depend on a poll interval.
      const drafts = await prisma.invitation.findMany({
        where: { projectId, status: 'DRAFT' },
        select: { id: true },
      });
      for (const draft of drafts) await sendInvitation(prisma, lead, draft.id);

      // Varied responses: enough accept to fill every seat with spares, three
      // decline, and one is simply left unanswered. Some of the accepters have
      // never declared availability — they are not staffable, and the attention
      // queue is supposed to say so rather than quietly skip them.
      const sent = await prisma.invitation.findMany({
        where: { projectId, status: 'SENT' },
        orderBy: { createdAt: 'asc' },
      });
      let accepted = 0;
      let declined = 0;
      for (const [position, invitation] of sent.entries()) {
        if (position < area.seats + 4) {
          await respondToInvitation(prisma, invitation.expertId, {
            invitationId: invitation.id,
            accept: true,
          });
          accepted += 1;
        } else if (position < area.seats + 7) {
          await respondToInvitation(prisma, invitation.expertId, {
            invitationId: invitation.id,
            accept: false,
            declineReason: 'Committed elsewhere for this window.',
          });
          declined += 1;
        }
      }

      const counts = await prisma.invitation.groupBy({
        by: ['status'],
        where: { projectId },
        _count: true,
      });
      const byStatus = Object.fromEntries(counts.map((row) => [row.status, row._count]));
      rows.push({
        area: area.domainName,
        invited: Object.values(byStatus).reduce((total, value) => total + value, 0),
        accepted: byStatus.ACCEPTED ?? 0,
        declined: byStatus.DECLINED ?? 0,
        noResponse: byStatus.SENT ?? 0,
        batch: batchReference,
      });
      void accepted;
      void declined;
    }
    return rows;
  });

  say(`\n  6    outreach (every batch approved by an account other than its creator)`);
  for (const row of outreach) {
    say(
      `       ${row.area}: batch ${row.batch} — ${row.invited} invited, ${row.accepted} accepted, ` +
        `${row.declined} declined, ${row.noResponse} no response`,
    );
  }

  // --- 7. onboarding, verification and confirmed seats ----------------------
  async function onboardAndVerify(expertId: string, fullName: string) {
    const expert = await prisma.expert.findUnique({ where: { id: expertId } });
    if (!expert) return;
    if (expert.status === 'VERIFIED') return;
    await startOnboarding(prisma, lead, expertId);
    const onboarding = await prisma.onboardingCase.findUnique({ where: { expertId } });
    if (!onboarding) return;
    if (onboarding.status === 'IN_PROGRESS') {
      await saveChecklistAnswers(prisma, { type: 'EXPERT', expertId, label: fullName }, expertId, [
        { key: 'profile_confirmed', value: 'true' },
        { key: 'nda_accepted', value: 'true' },
        { key: 'conflict_check', value: 'None.' },
        { key: 'engagement_terms', value: 'true' },
        { key: 'billing_reference', value: `NET-BILL-${expert.reference}` },
        { key: 'working_notes', value: 'Seeded network member.' },
      ]);
      await submitOnboarding(prisma, { type: 'EXPERT', expertId, label: fullName }, expertId);
    }
    const resubmitted = await prisma.onboardingCase.findUnique({ where: { expertId } });
    if (resubmitted?.status === 'SUBMITTED') {
      // HUMAN DECISION in the application. Recorded here against the operator
      // running the exercise, exactly as the UI would record it.
      await decideVerification(prisma, lead, {
        expertId,
        approve: true,
        note: 'Network exercise: checklist complete.',
      });
    }
  }

  async function fillSeats(area: AreaSpec): Promise<number> {
    const projectId = areaIds[area.key]!.projectId;
    const confirmedAlready = await prisma.assignment.count({
      where: { projectId, status: { in: ['CONFIRMED', 'COMPLETED'] } },
    });
    let filled = confirmedAlready;
    if (filled >= area.seats) return filled;

    const acceptances = await prisma.invitation.findMany({
      where: { projectId, status: 'ACCEPTED' },
      include: { expert: true },
      orderBy: { respondedAt: 'asc' },
    });
    for (const invitation of acceptances) {
      if (filled >= area.seats) break;
      const seat = await prisma.assignment.findUnique({
        where: { projectId_expertId: { projectId, expertId: invitation.expertId } },
      });
      if (seat && ['CONFIRMED', 'COMPLETED'].includes(seat.status)) continue;

      await onboardAndVerify(invitation.expertId, invitation.expert.fullName);
      const declared = await prisma.availabilityWindow.findFirst({
        where: { expertId: invitation.expertId, projectId: null },
      });
      if (!declared) continue;

      const proposed =
        seat && seat.status === 'PROPOSED'
          ? seat
          : await proposeAssignment(prisma, lead, {
              projectId,
              expertId: invitation.expertId,
              allocationHoursPerWeek: Math.min(10, declared.hoursPerWeek),
            });
      const result = await confirmAssignment(prisma, lead, proposed.id);
      filled = result.seatsFilled;
    }
    return filled;
  }

  // Capacity that is already spoken for. A project-scoped window may only be
  // declared once the expert has accepted that project's invitation, which is
  // why this runs after outreach rather than at seeding time.
  const commitments = await phase('commitments', async () => {
    const overlapping = new Set(
      planned.filter((person) => person.overlappingCommitment).map((person) => person.email),
    );
    let declared = 0;
    for (const area of AREAS) {
      const projectId = areaIds[area.key]!.projectId;
      const accepted = await prisma.invitation.findMany({
        where: { projectId, status: 'ACCEPTED' },
        include: { expert: true },
      });
      for (const invitation of accepted) {
        if (!overlapping.has(invitation.expert.email)) continue;
        const already = await prisma.availabilityWindow.count({
          where: { expertId: invitation.expertId, projectId },
        });
        if (already > 0) continue;
        const start = new Date(Date.now() + 5 * DAY);
        await declareAvailability(
          prisma,
          { type: 'EXPERT', expertId: invitation.expertId, label: invitation.expert.fullName },
          invitation.expertId,
          {
            startAt: start,
            endAt: new Date(start.getTime() + 80 * DAY),
            hoursPerWeek: 5,
            projectId,
            note: `Capacity already committed on ${area.project.current}`,
          },
        );
        declared += 1;
      }
    }
    return declared;
  });

  say(`\n  6b   ${commitments} project-scoped commitment window(s) declared`);

  const seating = await phase('staffing', async () => {
    const rows: { area: string; filled: number; seats: number }[] = [];
    for (const area of AREAS) {
      const filled = await fillSeats(area);
      rows.push({ area: area.domainName, filled, seats: area.seats });
      if (filled < area.seats) {
        say(
          `       note: ${area.domainName} is ${filled}/${area.seats}. Everyone who accepted and ` +
            'declared availability is seated; the rest are in the attention queue.',
        );
      }
    }
    return rows;
  });

  say(`\n  7    staffing`);
  for (const row of seating) say(`       ${row.area}: ${row.filled}/${row.seats} seats confirmed`);

  // --- 8. two withdrawals, and restaffing ----------------------------------
  const withdrawals = await phase('withdrawals', async () => {
    const notes: string[] = [];
    const targets = [AREAS[0]!, AREAS[2]!];
    for (const area of targets) {
      const projectId = areaIds[area.key]!.projectId;
      const alreadyWithdrawn = await prisma.assignment.count({
        where: { projectId, status: 'RELEASED' },
      });
      if (alreadyWithdrawn > 0) {
        notes.push(`${area.domainName}: already exercised`);
        continue;
      }
      const seat = await prisma.assignment.findFirst({
        where: { projectId, status: 'CONFIRMED' },
        include: { expert: true },
        orderBy: { confirmedAt: 'desc' },
      });
      if (!seat) {
        notes.push(`${area.domainName}: no confirmed seat to withdraw`);
        continue;
      }
      const result = await recordWithdrawal(
        prisma,
        {
          type: 'EXPERT',
          expertId: seat.expertId,
          label: seat.expert.fullName,
        },
        {
          projectId,
          expertId: seat.expertId,
          reason: 'Network exercise: stepping off to test the replacement path.',
        },
      );
      notes.push(
        `${area.domainName}: ${seat.expert.fullName} left — ${result.seatsFilled}/${area.seats} seats, ` +
          `${result.cancelledWorkItemIds.length} outstanding item(s) cancelled`,
      );
    }

    // Matching again, while the vacated projects are back in STAFFING. This is
    // the only moment the decline cool-off is visible: the people who turned
    // the first invitation down are excluded from the replacement ranking.
    for (const area of targets) {
      const projectId = areaIds[area.key]!.projectId;
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project || !['MATCHING', 'INVITING', 'STAFFING'].includes(project.status)) continue;
      const run = await runMatching(prisma, lead, projectId, { limit: 100, includeExcluded: true });
      const candidates = await prisma.matchCandidate.findMany({
        where: { matchRunId: run.id },
        select: { excluded: true, exclusionReason: true },
      });
      const reasons = new Map<string, number>();
      for (const candidate of candidates) {
        if (!candidate.excluded || !candidate.exclusionReason) continue;
        reasons.set(
          candidate.exclusionReason.replace(/\d+/g, 'N'),
          (reasons.get(candidate.exclusionReason.replace(/\d+/g, 'N')) ?? 0) + 1,
        );
      }
      notes.push(
        `${area.domainName}: re-ranked ${candidates.filter((c) => !c.excluded).length} for the vacant seat`,
      );
      for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
        notes.push(`  ${count} × ${reason}`);
      }
    }

    const sweep = await detectStaffingGaps(prisma);
    notes.push(
      `gap sweep: ${sweep.projectsChecked} projects checked, ${sweep.gapsFound} gaps, ` +
        `${sweep.attentionRaised} attention item(s) raised`,
    );

    // Replacement: recommended, approved by a second identity, dispatched.
    for (const area of targets) {
      const projectId = areaIds[area.key]!.projectId;
      const shortfall = await prisma.assignment.count({
        where: { projectId, status: { in: ['CONFIRMED', 'COMPLETED'] } },
      });
      if (shortfall >= area.seats) continue;

      const { batch, recommendations } = await buildReplacementBatch(prisma, coordinator, {
        projectId,
        reason: 'Network exercise: replacing a seat vacated by a withdrawal.',
        limit: 5,
      });
      if (!batch) {
        notes.push(`${area.domainName}: no replacement candidates (${recommendations} considered)`);
        continue;
      }
      await submitOutreachForApproval(prisma, coordinator, batch.id);
      await decideBatch(prisma, approver, {
        batchId: batch.id,
        approve: true,
        note: 'Replacement outreach approved by a different account than its creator.',
      });
      const dispatched = await dispatchBatch(prisma, approver, batch.id);
      notes.push(
        `${area.domainName}: replacement batch ${batch.reference} — ${recommendations} recommended, ` +
          `${dispatched.dispatched} invited, ${dispatched.skipped.length} skipped`,
      );

      const drafts = await prisma.invitation.findMany({
        where: { projectId, status: 'DRAFT' },
        select: { id: true },
      });
      for (const draft of drafts) await sendInvitation(prisma, lead, draft.id);

      const fresh = await prisma.invitation.findMany({
        where: { projectId, status: 'SENT' },
        orderBy: { sentAt: 'desc' },
        take: 3,
      });
      for (const invitation of fresh) {
        await respondToInvitation(prisma, invitation.expertId, {
          invitationId: invitation.id,
          accept: true,
        });
      }
      const filled = await fillSeats(area);
      notes.push(`${area.domainName}: restaffed to ${filled}/${area.seats}`);
    }
    return notes;
  });

  say(`\n  8    withdrawal and replacement`);
  for (const note of withdrawals) say(`       ${note}`);

  // --- 9. work, review, payment preparation --------------------------------
  const money = await phase('payments', async () => {
    const notes: string[] = [];
    const area = AREAS[1]!;
    const projectId = areaIds[area.key]!.projectId;
    const seats = await prisma.assignment.findMany({
      where: { projectId, status: 'CONFIRMED' },
      include: { expert: true },
      orderBy: { confirmedAt: 'asc' },
      take: 3,
    });
    if (seats.length === 0) {
      notes.push('no confirmed seats to assign work to');
      return notes;
    }

    const itemIds: string[] = [];
    for (const [position, seat] of seats.entries()) {
      const hours = 6 + position;
      let workItem = await prisma.workItem.findFirst({
        where: {
          assignmentId: seat.id,
          // Either spelling: rows seeded before the rename carry the old prefix.
          OR: [
            { title: { startsWith: 'Scoping note' } },
            { title: { startsWith: 'NET scoping note' } },
          ],
        },
      });
      if (!workItem) {
        workItem = await createWorkItem(prisma, lead, {
          assignmentId: seat.id,
          title: `Scoping note ${position + 1}`,
          instructions: 'Two pages on where the process stalls. Synthetic exercise only.',
          basis: 'HOURLY',
          dueAt: new Date(Date.now() + 7 * DAY),
        });
      }
      if (workItem.status === 'ASSIGNED' || workItem.status === 'REVISION_REQUESTED') {
        await submitWork(
          prisma,
          { type: 'EXPERT', expertId: seat.expertId, label: seat.expert.fullName },
          {
            workItemId: workItem.id,
            summary: 'Scoping note, first pass.',
            content: 'Synthetic deliverable written for the network exercise.',
            hoursClaimed: hours,
          },
        );
      }
      const submitted = await prisma.workItem.findUnique({ where: { id: workItem.id } });
      if (submitted?.status === 'SUBMITTED') {
        // The last one is approved for fewer hours than claimed, so the
        // discrepancy path is exercised rather than described.
        const approvedHours = position === seats.length - 1 ? hours - 1 : hours;
        await reviewWork(prisma, lead, {
          workItemId: workItem.id,
          approve: true,
          summary: 'Clear enough to pay for.',
          feedback: { accuracy: 'Checks out.', clarity: 'Readable.' },
          approvedQuantity: approvedHours,
        });
      }
      const draft = await draftPaymentFromApprovedWork(prisma, lead, { workItemId: workItem.id });
      // A flagged item is held at DRAFT until a person explains the difference.
      if (draft.discrepancies.length > 0 && draft.item.status === 'DRAFT') {
        await resolveDiscrepancy(prisma, lead, {
          paymentItemId: draft.item.id,
          resolution: `Approved ${draft.item.quantity} of the hours claimed; the rest was out of scope.`,
        });
      }
      itemIds.push(draft.item.id);
    }

    const readyItems = await prisma.paymentItem.findMany({
      where: { id: { in: itemIds }, status: 'READY', batchId: null },
    });
    if (readyItems.length === 0) {
      const existing = await prisma.paymentBatch.findFirst({
        where: { items: { some: { id: { in: itemIds } } } },
        include: { items: true },
      });
      notes.push(
        existing
          ? `batch ${existing.reference} already ${existing.status.toLowerCase()} with ${existing.items.length} item(s)`
          : 'no payment items ready to batch',
      );
      return notes;
    }

    const batch = await createPaymentBatch(prisma, coordinator, {
      periodStart: new Date(Date.now() - 14 * DAY),
      periodEnd: new Date(),
      note: 'Network exercise',
      itemIds: readyItems.map((item) => item.id),
    });
    await submitPaymentForApproval(prisma, coordinator, batch.id);
    notes.push(`batch ${batch.reference} created and submitted by ${coordinator.label}`);

    // Segregation of duties, demonstrated rather than asserted.
    let refused = false;
    try {
      await approveBatch(prisma, coordinator, { batchId: batch.id });
    } catch (error) {
      refused = true;
      notes.push(
        `self-approval refused: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!refused) fail('A batch was approved by its own creator. That must never happen.');

    await approveBatch(prisma, approver, {
      batchId: batch.id,
      note: 'Approved by a second account identity for the exercise.',
    });
    const exported = await exportBatch(prisma, approver, batch.id);

    const lines = exported.csv.trim().split('\n');
    const references = lines
      .slice(1)
      .map((line) => line.split(',')[0]?.replace(/^["']|"$/g, '') ?? '');
    const unique = new Set(references);
    const afterExport = await prisma.paymentBatch.findUnique({
      where: { id: batch.id },
      include: { items: true },
    });
    notes.push(
      `exported ${lines.length - 1} row(s), ${unique.size} distinct reference(s), ` +
        `total ${(afterExport!.totalMinor / 100).toFixed(2)} ${afterExport!.currency}`,
    );
    // There is no PAID status in the schema at all, which is a stronger
    // statement than any assertion: this system cannot record a payment.
    notes.push(
      `batch status after export: ${afterExport!.status}; item statuses: ` +
        `${[...new Set(afterExport!.items.map((item) => item.status))].join(', ')} ` +
        '(the schema has no PAID state — nothing here can mark anyone paid)',
    );
    if (unique.size !== references.length) fail('A payment item appears twice in the export.');
    return notes;
  });

  say(`\n  9    work, review and payment preparation`);
  for (const note of money) say(`       ${note}`);

  // --- 10. the shape of the network afterwards ------------------------------
  const byStatus = await prisma.expert.groupBy({ by: ['status'], _count: true });
  const seededCount = await prisma.expert.count({
    where: { email: { startsWith: 'net.', endsWith: `@${FIXTURE_EMAIL_DOMAIN}` } },
  });
  const applicantCount = await prisma.application.count();
  const assignmentCounts = await prisma.assignment.groupBy({ by: ['status'], _count: true });
  const attention = await prisma.attentionItem.count({ where: { status: 'OPEN' } });
  const pendingJobs = await prisma.job.count({ where: { status: { in: ['PENDING', 'RUNNING'] } } });

  say(`\n  10   the network afterwards`);
  say(
    `       experts by status   ${byStatus.map((row) => `${row.status} ${row._count}`).join(', ')}`,
  );
  say(`       seeded experts            ${seededCount} — none of them applied`);
  say(`       applications        ${applicantCount} (from /apply/opportunities only)`);
  say(
    `       assignments         ${assignmentCounts.map((row) => `${row.status} ${row._count}`).join(', ')}`,
  );
  say(`       open attention      ${attention}`);
  say(`       pending jobs        ${pendingJobs}`);

  say(`\n  timings (ms)`);
  for (const [name, ms] of Object.entries(timings)) say(`       ${name.padEnd(16)} ${ms}`);
  say(`       ${'total'.padEnd(16)} ${Date.now() - startedAt}`);
  say(`\n  Every record is synthetic. Email is simulated and no payment executes.\n`);
}

main()
  .catch((error) => {
    console.error(`\n  ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
