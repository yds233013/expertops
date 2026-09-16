/**
 * Put a small, obviously synthetic dataset on a deployment.
 *
 * A staging box with an empty database tells a tester nothing, and a staging
 * box seeded with `prisma/seed.ts` would carry the shared demo operator
 * accounts. This is the middle: a couple of experts and one project, every
 * record a seeded fixture (`demoEligible`), and no operator accounts at all.
 *
 *   npx tsx scripts/staging-fixtures.ts
 *
 * Idempotent. Re-running it changes nothing, so it is safe to put in a deploy
 * script.
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import { parseDatabaseUrl } from '@/lib/database-safety';
import { SYSTEM_ACTOR, type Actor } from '@/server/services/activity';
import { createExpert } from '@/server/services/experts';
import { createProject } from '@/server/services/projects';
import { PERSON_RENAMES, PROJECT_RENAMES, SAMPLE_CLIENT, eitherName } from './fixture-names';

const EXPERTS = [
  {
    fullName: PERSON_RENAMES['synthetic.avery.lindqvist@example.test']!.current,
    email: 'synthetic.avery.lindqvist@example.test',
    headline: PERSON_RENAMES['synthetic.avery.lindqvist@example.test']!.headline.current,
    yearsExperience: 9,
    hourlyRateCents: 18_000,
    skills: [{ name: 'Evaluation Design', proficiency: 4, yearsUsed: 5 }],
  },
  {
    fullName: PERSON_RENAMES['synthetic.bo.okonkwo@example.test']!.current,
    email: 'synthetic.bo.okonkwo@example.test',
    headline: PERSON_RENAMES['synthetic.bo.okonkwo@example.test']!.headline.current,
    yearsExperience: 12,
    hourlyRateCents: 20_000,
    skills: [{ name: 'Evaluation Design', proficiency: 5, yearsUsed: 8 }],
  },
  // Two more than the sandbox project has seats. A withdrawal cannot be
  // rehearsed without somebody left to replace the expert who withdrew, and a
  // staging box with exactly as many experts as seats can only ever
  // demonstrate the happy path.
  {
    fullName: PERSON_RENAMES['synthetic.cleo.marchetti@example.test']!.current,
    email: 'synthetic.cleo.marchetti@example.test',
    headline: PERSON_RENAMES['synthetic.cleo.marchetti@example.test']!.headline.current,
    yearsExperience: 7,
    hourlyRateCents: 17_500,
    skills: [{ name: 'Evaluation Design', proficiency: 4, yearsUsed: 4 }],
  },
  {
    fullName: PERSON_RENAMES['synthetic.dara.nkemelu@example.test']!.current,
    email: 'synthetic.dara.nkemelu@example.test',
    headline: PERSON_RENAMES['synthetic.dara.nkemelu@example.test']!.headline.current,
    yearsExperience: 15,
    hourlyRateCents: 22_000,
    skills: [{ name: 'Evaluation Design', proficiency: 5, yearsUsed: 10 }],
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');

  const target = parseDatabaseUrl(url);
  if (target.kind !== 'unknown') {
    throw new Error(
      `Refusing to write fixtures to the ${target.kind} database ("${target.name}"). ` +
        'This script is for a deployment; development has `npm run db:seed`.',
    );
  }

  // Fixtures are created by the system, not by a person: nobody on a staging
  // box should appear in the history as having added records they never added.
  const actor: Actor = SYSTEM_ACTOR;

  let created = 0;
  for (const definition of EXPERTS) {
    const existing = await prisma.expert.findUnique({ where: { email: definition.email } });
    if (existing) continue;
    const expert = await createExpert(prisma, actor, definition);
    // Only the script that made a record can vouch for where it came from.
    await prisma.expert.update({ where: { id: expert.id }, data: { demoEligible: true } });
    created += 1;
  }

  const projectTitle = PROJECT_RENAMES.staging.current;
  let project = await prisma.project.findFirst({
    where: { title: eitherName(PROJECT_RENAMES.staging) },
  });
  if (!project) {
    // `createProject` requires a signed-in operator, so this needs the first
    // operator to exist. That ordering is deliberate: bootstrap the operator,
    // then the fixtures, and the project is owned by a real account.
    const owner = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!owner) {
      throw new Error(
        'No operator exists yet. Run scripts/bootstrap-operator.ts first, then this script.',
      );
    }
    project = await createProject(
      prisma,
      { type: 'OPERATOR', userId: owner.id, label: `${owner.name} <${owner.email}>` },
      {
        title: projectTitle,
        clientName: SAMPLE_CLIENT,
        description:
          'Synthetic record for the staging environment. No real client, no real work, and every message this project produces is simulated.',
        seatsRequested: 2,
        minYearsExperience: 5,
        maxHourlyRateCents: 25_000,
        requirements: [{ skillName: 'Evaluation Design', required: true, minProficiency: 3 }],
      },
    );
  }

  await prisma.project.update({ where: { id: project.id }, data: { demoEligible: true } });

  console.log(`\n  Staging fixtures on ${target.redactedUrl}`);
  console.log(`    experts created this run  ${created}`);
  console.log(`    experts total             ${await prisma.expert.count()}`);
  console.log(`    project                   ${project.code} — ${project.title}`);
  console.log('\n  Every record is synthetic. Email remains simulated.\n');
}

main()
  .catch((error) => {
    console.error(
      `\n  Fixtures failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
