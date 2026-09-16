/**
 * A practice opportunity with a seat nobody is sitting in.
 *
 *   npx tsx scripts/practice-hands-on.ts
 *
 * The thirty seats from the network exercise are all confirmed, and releasing
 * one to make room would damage the thing it took a day to build. So this makes
 * its own project, its own seat and its own listing, standing apart from the
 * exercise and obvious in any list.
 *
 * Idempotent: everything is looked up before it is created. Running it twice
 * leaves one copy and changes nothing.
 *
 * It deliberately stops at "published and empty". The application, the
 * screening, the revision, the qualification and the staffing are the exercise,
 * and they are left undone on purpose.
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import { parseDatabaseUrl } from '@/lib/database-safety';
import { type Actor } from '@/server/services/activity';
import { createProject, setProjectStatus } from '@/server/services/projects';
import { createOpportunity, publishOpportunity } from '@/server/services/opportunities';
import { OPPORTUNITY_RENAMES, PROJECT_RENAMES, SAMPLE_CLIENT, eitherName } from './fixture-names';

const PROJECT = PROJECT_RENAMES.handsOn;
const OPPORTUNITY = OPPORTUNITY_RENAMES.handsOn;
const DOMAIN_SLUG = 'practice-coding';
const SKILL = 'Code Review';
const DAY = 24 * 60 * 60 * 1000;

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) fail('DATABASE_URL is not set.');
  const target = parseDatabaseUrl(url);
  if (target.kind === 'development') {
    fail(`Refusing to seed the development database ("${target.name}").`);
  }

  const owner = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
    orderBy: { createdAt: 'asc' },
  });
  if (!owner) fail('No ADMIN operator exists yet.');
  const actor: Actor = {
    type: 'OPERATOR',
    userId: owner.id,
    label: `${owner.name} <${owner.email}>`,
  };

  const domain = await prisma.domain.findUnique({ where: { slug: DOMAIN_SLUG } });
  if (!domain) fail(`Domain ${DOMAIN_SLUG} is missing. Run scripts/network-exercise.ts first.`);

  // --- the project, with one seat -----------------------------------------
  let project = await prisma.project.findFirst({ where: { title: eitherName(PROJECT) } });
  let createdProject = false;
  if (!project) {
    project = await createProject(prisma, actor, {
      title: PROJECT.current,
      clientName: SAMPLE_CLIENT,
      description:
        'A practice project kept deliberately empty so somebody can take a candidate all the ' +
        'way from an application to a confirmed seat without disturbing the network exercise.',
      seatsRequested: 1,
      // Low enough that the profile step is quick, high enough that it matters:
      // a newly qualified expert carries zero years and will be excluded until
      // somebody fills the profile in.
      minYearsExperience: 1,
      maxHourlyRateCents: 30_000,
      requirements: [{ skillName: SKILL, required: true, minProficiency: 3 }],
    });
    createdProject = true;
  }

  // A seeded fixture, so it may appear in the anonymous demo. Set here because
  // only the thing that created the record can vouch for where it came from.
  await prisma.project.update({ where: { id: project.id }, data: { demoEligible: true } });

  // Open for matching, which is where invitations become possible.
  if (project.status === 'DRAFT') {
    project = await setProjectStatus(prisma, actor, project.id, 'MATCHING', {
      reason: 'Hands-on practice: open for matching',
    });
  }

  // --- the listing ---------------------------------------------------------
  let opportunity = await prisma.opportunity.findFirst({
    where: { title: eitherName(OPPORTUNITY) },
  });
  let createdOpportunity = false;
  if (!opportunity) {
    opportunity = await createOpportunity(prisma, actor, {
      title: OPPORTUNITY.current,
      kind: 'PROJECT_ENGAGEMENT',
      domainId: domain.id,
      projectId: project.id,
      summary: 'A practice listing with one open seat, kept for a hands-on walkthrough.',
      description:
        'A practice engagement. Nothing here is real client work and nobody is hired from it. ' +
        'It exists so the whole path — application, screening, revision, qualification, ' +
        'onboarding and a confirmed seat — can be walked through on one record.',
      responsibilities:
        'Read a small changeset.\nWrite a short review naming specific risks.\nSay what you ' +
        'would refuse to merge, and why.',
      requiredSkills: [SKILL],
      weeklyHoursMin: 4,
      weeklyHoursMax: 8,
      applicationDeadline: new Date(Date.now() + 60 * DAY),
      compensationNote: 'Practice listing — no compensation is offered or implied.',
      internalNotes:
        'Hands-on practice record. Client identity and rate ceiling would live here on a real ' +
        'listing and must never reach the candidate-facing page. Used to check that separation.',
      questions: [
        {
          key: 'review-example',
          label: 'Describe one review where you changed the outcome. What did you do?',
          required: true,
        },
        {
          key: 'availability-note',
          label: 'Anything we should know about your availability?',
          required: false,
        },
      ],
    });
    await publishOpportunity(prisma, actor, opportunity.id);
    createdOpportunity = true;
  }

  const fresh = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
  const applications = await prisma.application.count({ where: { opportunityId: opportunity.id } });
  const rubric = await prisma.screeningRubricVersion.findFirst({
    where: { status: 'PUBLISHED', template: { domain: { slug: DOMAIN_SLUG } } },
    select: { version: true, template: { select: { name: true } } },
    orderBy: { version: 'desc' },
  });

  console.log(`\n  Hands-on practice board on ${target.redactedUrl}\n`);
  console.log(`    project       ${fresh.code} ${fresh.title}`);
  console.log(
    `    status        ${fresh.status}, seats ${fresh.seatsFilled}/${fresh.seatsRequested}`,
  );
  console.log(`    requires      ${SKILL} at 3/5, minimum ${fresh.minYearsExperience} year(s)`);
  console.log(`    opportunity   ${opportunity.reference} ${opportunity.title}`);
  console.log(`    candidate URL /apply/opportunities/${opportunity.slug}`);
  console.log(`    operator URL  /opportunities/${opportunity.id}`);
  console.log(
    `    rubric        ${rubric ? `${rubric.template.name} v${rubric.version}` : 'NONE — publish one first'}`,
  );
  console.log(`    applications  ${applications}`);
  console.log(
    `\n    created this run: ${
      [createdProject && 'project', createdOpportunity && 'opportunity']
        .filter(Boolean)
        .join(', ') || 'nothing'
    }`,
  );
  console.log('\n  The seat is empty on purpose. Nothing about the journey has been done.\n');
}

main()
  .catch((error) => {
    console.error(`\n  ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
