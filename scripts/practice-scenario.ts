/**
 * Set up a practice scenario, without disturbing anything already there.
 *
 * A walkthrough needs a board that is mid-game: a project with a seat open, one
 * expert who can take it, one who looks like they can but cannot, and one held
 * back as a replacement for when somebody withdraws. Plus a rubric and a
 * candidate, so the screening half has something to screen.
 *
 *   npx tsx scripts/practice-scenario.ts
 *
 * Every record is prefixed PRACTICE so it is obvious in a list and easy to find
 * again. Idempotent: it looks for each record before creating it, so running it
 * twice leaves one copy of everything and changes nothing else.
 *
 * It deliberately stops short of the interesting part. Nothing is invited,
 * nobody is staffed and no work exists — those are the steps to practise.
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import { parseDatabaseUrl } from '@/lib/database-safety';
import { SYSTEM_ACTOR, type Actor } from '@/server/services/activity';
import { createExpert } from '@/server/services/experts';
import { createProject } from '@/server/services/projects';
import { createCandidate } from '@/server/services/candidates';
import { createDraftVersion, createTemplate, publishVersion } from '@/server/services/screening';
import { ensureOnboardingCase } from '@/server/services/onboarding';

const PREFIX = 'PRACTICE';
const SKILL = 'Evaluation Design';

/** The three experts, and what each one is for. */
const EXPERTS = [
  {
    key: 'ready',
    fullName: `${PREFIX} Nadia Halvorsen`,
    email: 'practice.nadia.halvorsen@example.test',
    headline: `${PREFIX} record — ready to staff`,
    yearsExperience: 11,
    hourlyRateCents: 19_000,
    /** Verified and available: the one a seat can be confirmed for. */
    readiness: 'ready' as const,
  },
  {
    key: 'blocked',
    fullName: `${PREFIX} Tomas Ferreira`,
    email: 'practice.tomas.ferreira@example.test',
    headline: `${PREFIX} record — onboarding not finished`,
    yearsExperience: 9,
    hourlyRateCents: 18_500,
    /**
     * Looks staffable in a list and is not: the checklist is open, so
     * verification has not happened and the seat will be refused.
     */
    readiness: 'blocked' as const,
  },
  {
    key: 'replacement',
    fullName: `${PREFIX} Ingrid Sørensen`,
    email: 'practice.ingrid.sorensen@example.test',
    headline: `${PREFIX} record — holds back as a replacement`,
    yearsExperience: 13,
    hourlyRateCents: 21_000,
    readiness: 'ready' as const,
  },
];

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) fail('DATABASE_URL is not set.');
  const target = parseDatabaseUrl(url);
  if (target.kind !== 'unknown') {
    fail(
      `Refusing to seed the ${target.kind} database ("${target.name}"). ` +
        'This is for a deployment; development has `npm run db:seed`.',
    );
  }

  const owner = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!owner) fail('No operator exists yet. Run scripts/bootstrap-operator.ts first.');
  const actor: Actor = {
    type: 'OPERATOR',
    userId: owner.id,
    label: `${owner.name} <${owner.email}>`,
  };

  const created: string[] = [];
  const kept: string[] = [];

  // --- experts -------------------------------------------------------------
  const experts: Record<string, string> = {};
  for (const definition of EXPERTS) {
    const existing = await prisma.expert.findUnique({ where: { email: definition.email } });
    if (existing) {
      experts[definition.key] = existing.id;
      kept.push(definition.fullName);
      continue;
    }
    const expert = await createExpert(prisma, SYSTEM_ACTOR, {
      fullName: definition.fullName,
      email: definition.email,
      headline: definition.headline,
      yearsExperience: definition.yearsExperience,
      hourlyRateCents: definition.hourlyRateCents,
      skills: [{ name: SKILL, proficiency: 4, yearsUsed: 5 }],
    });
    experts[definition.key] = expert.id;
    created.push(definition.fullName);

    if (definition.readiness === 'ready') {
      // Verified, with availability on file: a seat can be confirmed.
      await prisma.expert.update({ where: { id: expert.id }, data: { status: 'VERIFIED' } });
      const now = new Date();
      await prisma.availabilityWindow.create({
        data: {
          expertId: expert.id,
          startAt: now,
          endAt: new Date(now.getTime() + 120 * 24 * 60 * 60 * 1000),
          hoursPerWeek: 25,
          note: `${PREFIX} availability`,
        },
      });
    } else {
      // An open checklist and no verification. The staffing screen will say so
      // rather than simply omitting them, which is the point of the exercise.
      await prisma.expert.update({ where: { id: expert.id }, data: { status: 'ONBOARDING' } });
      await ensureOnboardingCase(prisma, expert.id);
    }
  }

  // --- project -------------------------------------------------------------
  const projectTitle = `${PREFIX} evaluation pilot`;
  let project = await prisma.project.findFirst({ where: { title: projectTitle } });
  if (!project) {
    project = await createProject(prisma, actor, {
      title: projectTitle,
      clientName: `${PREFIX} Client (practice only)`,
      description:
        'Practice scenario. No real client and no real work. Two seats, one skill, ' +
        'and three experts in the network at different stages of readiness.',
      seatsRequested: 2,
      minYearsExperience: 5,
      maxHourlyRateCents: 25_000,
      requirements: [{ skillName: SKILL, required: true, minProficiency: 3 }],
    });
    created.push(projectTitle);
  } else {
    kept.push(projectTitle);
  }

  // --- rubric, so screening can be practised --------------------------------
  const domainSlug = `${PREFIX.toLowerCase()}-evaluation`;
  let domain = await prisma.domain.findUnique({ where: { slug: domainSlug } });
  if (!domain) {
    domain = await prisma.domain.create({
      data: {
        slug: domainSlug,
        name: `${PREFIX} Evaluation`,
        description: 'Practice domain. Not a real area of work.',
      },
    });
    created.push(`${PREFIX} Evaluation domain`);
  } else {
    kept.push(`${PREFIX} Evaluation domain`);
  }

  const templateName = `${PREFIX} evaluation screening`;
  let template = await prisma.screeningTemplate.findFirst({ where: { name: templateName } });
  if (!template) {
    template = await createTemplate(prisma, actor, {
      name: templateName,
      domainId: domain.id,
      description: 'Practice rubric. Publish a version, then screen the practice candidate.',
    });
    const draft = await createDraftVersion(prisma, actor, {
      templateId: template.id,
      guidance: 'Practice rubric. Score honestly; nothing here affects a real person.',
      changeNote: 'First version, created by the practice scenario.',
      criteria: [
        {
          key: 'method',
          label: 'Describes a defensible evaluation method',
          scoringGuidance: 'Look for a named design and why it suits the question.',
          requiredEvidence: 'WRITTEN_ANSWER',
        },
        {
          key: 'evidence',
          label: 'Points at real prior work',
          scoringGuidance: 'A link to something they actually produced.',
          requiredEvidence: 'WORK_SAMPLE_LINK',
        },
      ],
    });
    await publishVersion(prisma, actor, draft.id);
    created.push(`${templateName} (v1 published)`);
  } else {
    kept.push(templateName);
  }

  // --- candidate, waiting to be screened ------------------------------------
  const candidateEmail = 'practice.rosa.imani@example.test';
  const existingCandidate = await prisma.candidate.findFirst({
    where: { email: candidateEmail },
  });
  if (!existingCandidate) {
    await createCandidate(prisma, actor, {
      fullName: `${PREFIX} Rosa Imani`,
      email: candidateEmail,
      headline: `${PREFIX} applicant — awaiting a screening`,
      yearsExperience: 8,
    });
    created.push(`${PREFIX} Rosa Imani`);
  } else {
    kept.push(`${PREFIX} Rosa Imani`);
  }

  console.log(`\n  Practice scenario on ${target.redactedUrl}\n`);
  console.log(`    project            ${project.code} — ${projectTitle}`);
  console.log(`    seats              2 requested, 0 filled`);
  console.log(`    ready to staff     ${EXPERTS[0]!.fullName}`);
  console.log(`    blocked            ${EXPERTS[1]!.fullName} (onboarding unfinished)`);
  console.log(`    replacement        ${EXPERTS[2]!.fullName}`);
  console.log(`    rubric             ${templateName}`);
  console.log(`    candidate          ${PREFIX} Rosa Imani`);
  console.log(`\n    created this run   ${created.length ? created.join(', ') : 'nothing'}`);
  console.log(`    already present    ${kept.length ? kept.join(', ') : 'nothing'}`);
  console.log('\n  Every record is synthetic and prefixed PRACTICE. Nothing is invited or');
  console.log('  staffed: those are the steps to practise.\n');
}

main()
  .catch((error) => {
    console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
