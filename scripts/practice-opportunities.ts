/**
 * Publish three practice opportunities, and the projects they lead to.
 *
 *   npx tsx scripts/practice-opportunities.ts
 *
 * Idempotent: everything is looked up before it is created, so running it twice
 * leaves one copy and changes nothing.
 *
 * These are new records. Experts already in the network are left alone — none of
 * them is made to look like an applicant, because they never applied.
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import { parseDatabaseUrl } from '@/lib/database-safety';
import { type Actor } from '@/server/services/activity';
import { createProject } from '@/server/services/projects';
import { createOpportunity, publishOpportunity } from '@/server/services/opportunities';
import {
  DOMAIN_RENAMES,
  OPPORTUNITY_RENAMES,
  PROJECT_RENAMES,
  SAMPLE_CLIENT,
  eitherName,
} from './fixture-names';

const AREAS = [
  {
    slug: 'practice-coding',
    domain: DOMAIN_RENAMES['practice-coding'].current,
    project: PROJECT_RENAMES.coding,
    skill: 'Code Review',
    opportunity: OPPORTUNITY_RENAMES.coding,
    summary: 'Review synthetic pull requests and write short, specific notes.',
    description:
      'A practice engagement. You would read small changesets and say what you would ' +
      'change and why, in a few paragraphs each. Nothing here is real client code.',
    responsibilities:
      'Read a changeset.\nWrite a short review naming specific risks.\nFlag anything you ' +
      'would refuse to merge, and say why.',
    hours: [8, 12] as const,
    question: 'Describe a review where you disagreed with an author. What happened?',
  },
  {
    slug: 'practice-enterprise-business',
    domain: DOMAIN_RENAMES['practice-enterprise-business'].current,
    project: PROJECT_RENAMES.enterprise,
    skill: 'Process Analysis',
    opportunity: OPPORTUNITY_RENAMES.enterprise,
    summary: 'Map a synthetic back-office process and find where it stalls.',
    description:
      'A practice engagement. You would document how a fictional process actually runs, ' +
      'as opposed to how it is described, and point at the steps that cause delay.',
    responsibilities:
      'Interview synthetic stakeholders.\nMap the process as it runs.\nName the two or ' +
      'three steps where time is actually lost.',
    hours: [10, 20] as const,
    question: 'Tell us about a process you mapped. What did you find that surprised people?',
  },
  {
    slug: 'practice-cybersecurity',
    domain: DOMAIN_RENAMES['practice-cybersecurity'].current,
    project: PROJECT_RENAMES.cyber,
    skill: 'Threat Modelling',
    opportunity: OPPORTUNITY_RENAMES.cyber,
    summary: 'Threat-model a synthetic system and rank what actually matters.',
    description:
      'A practice engagement. You would work from an architecture description and say ' +
      'which threats are worth spending money on and which are not.',
    responsibilities:
      'Build a threat model from a written description.\nRank findings by realistic ' +
      'impact.\nSay plainly what you would not bother fixing.',
    hours: [6, 15] as const,
    question: 'Describe a finding you argued down in severity. Why were you right?',
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
      `Refusing to seed the ${target.kind} database ("${target.name}"). This is for a deployment.`,
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

  for (const area of AREAS) {
    let domain = await prisma.domain.findUnique({ where: { slug: area.slug } });
    if (!domain) {
      domain = await prisma.domain.create({
        data: {
          slug: area.slug,
          name: area.domain,
          description: 'Practice area. Not a real field of work.',
        },
      });
      created.push(area.domain);
    } else {
      kept.push(area.domain);
    }

    let project = await prisma.project.findFirst({ where: { title: eitherName(area.project) } });
    if (!project) {
      project = await createProject(prisma, actor, {
        title: area.project.current,
        clientName: SAMPLE_CLIENT,
        description: 'Practice project. No real client and no real work.',
        seatsRequested: 2,
        minYearsExperience: 3,
        maxHourlyRateCents: 25_000,
        requirements: [{ skillName: area.skill, required: true, minProficiency: 3 }],
      });
      created.push(`${project.code} ${area.project.current}`);
    } else {
      kept.push(area.project.current);
    }

    const existing = await prisma.opportunity.findFirst({
      where: { title: eitherName(area.opportunity) },
    });
    if (existing) {
      kept.push(area.opportunity.current);
      continue;
    }

    const opportunity = await createOpportunity(prisma, actor, {
      title: area.opportunity.current,
      kind: 'PROJECT_ENGAGEMENT',
      domainId: domain.id,
      projectId: project.id,
      summary: area.summary,
      description: area.description,
      responsibilities: area.responsibilities,
      requiredSkills: [area.skill],
      weeklyHoursMin: area.hours[0],
      weeklyHoursMax: area.hours[1],
      applicationDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      compensationNote: 'Practice listing — no compensation is offered or implied.',
      internalNotes:
        'Sample record. Client identity and rate ceiling would live here on a real ' +
        'listing, and never reach the candidate-facing page.',
      questions: [
        { key: 'relevant-work', label: area.question, required: true },
        {
          key: 'availability-note',
          label: 'Anything we should know about your availability?',
          required: false,
        },
      ],
    });
    await publishOpportunity(prisma, actor, opportunity.id);
    created.push(`${opportunity.reference} ${area.opportunity.current}`);
  }

  const experts = await prisma.expert.count();
  const applications = await prisma.application.count();

  console.log(`\n  Practice opportunities on ${target.redactedUrl}\n`);
  for (const area of AREAS) {
    console.log(`    /apply/opportunities/${await slugFor(area.opportunity.current)}`);
  }
  console.log(`\n    created this run   ${created.length ? created.join(', ') : 'nothing'}`);
  console.log(`    already present    ${kept.length ? kept.join(', ') : 'nothing'}`);
  console.log(`\n    experts in the network   ${experts} (untouched; none of them applied)`);
  console.log(`    applications so far      ${applications}`);
  console.log('\n  Every record is synthetic sample data.\n');
}

async function slugFor(title: string): Promise<string> {
  const row = await prisma.opportunity.findFirst({
    where: { title },
    select: { slug: true },
  });
  return row?.slug ?? '(not found)';
}

main()
  .catch((error) => {
    console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
