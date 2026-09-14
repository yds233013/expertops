/**
 * Rotate the three network-exercise accounts in one pass, and end their
 * sessions.
 *
 *   EXERCISE_LEAD_PASSWORD=… \
 *   EXERCISE_APPROVER_PASSWORD=… \
 *   EXERCISE_COORDINATOR_PASSWORD=… \
 *   ROTATION_REASON='…' \
 *   npx tsx scripts/rotate-exercise-operators.ts
 *
 * Why this exists rather than three runs of `rotate-operator-password.ts`:
 * a deployment with no shell access rotates a credential by setting a variable,
 * deploying once, and removing the variable again. Three of those is three
 * deploys and three windows in which a password sits in the service
 * configuration. One is one.
 *
 * Nothing is printed. Passwords are supplied, never generated, so the value
 * cannot reach a deploy log — which is the point, because the reason to run
 * this is usually that a value already reached somewhere it should not have.
 *
 * An account with no password supplied is skipped, not failed.
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import { parseDatabaseUrl } from '@/lib/database-safety';
import { DEMO_SEED_PASSWORD } from '@/lib/env';
import { SYSTEM_ACTOR } from '@/server/services/activity';
import { rotateOperatorPassword } from '@/server/services/auth';

const MIN_PASSWORD_LENGTH = 16;

const ACCOUNTS = [
  { key: 'lead', email: 'exercise.lead@example.test', variable: 'EXERCISE_LEAD_PASSWORD' },
  {
    key: 'approver',
    email: 'exercise.approver@example.test',
    variable: 'EXERCISE_APPROVER_PASSWORD',
  },
  {
    key: 'coordinator',
    email: 'exercise.coordinator@example.test',
    variable: 'EXERCISE_COORDINATOR_PASSWORD',
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
  if (target.kind === 'development') {
    fail(`Refusing to rotate on the development database ("${target.name}").`);
  }

  const reason = (process.env.ROTATION_REASON ?? '').trim();
  if (!reason) fail('ROTATION_REASON is required, and ends up in the activity history.');

  let rotated = 0;
  let skipped = 0;
  for (const account of ACCOUNTS) {
    const password = process.env[account.variable];
    if (password === undefined) {
      skipped += 1;
      continue;
    }
    if (password === DEMO_SEED_PASSWORD) fail(`${account.variable} is the shared demo password.`);
    if (password.length < MIN_PASSWORD_LENGTH) {
      fail(`${account.variable} must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    const existing = await prisma.user.findUnique({ where: { email: account.email } });
    if (!existing) {
      console.log(`    ${account.email} — no such account, nothing to rotate`);
      skipped += 1;
      continue;
    }

    const result = await rotateOperatorPassword(prisma, SYSTEM_ACTOR, {
      email: account.email,
      newPassword: password,
      reason,
    });
    console.log(`    ${account.email} — rotated, ${result.sessionsRevoked} session(s) ended`);
    rotated += 1;
  }

  console.log(`\n  Rotated ${rotated}, skipped ${skipped}, on ${target.redactedUrl}`);
  console.log('  No password was printed. Remove the variables now.\n');
}

main()
  .catch((error) => {
    console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
