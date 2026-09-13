/**
 * Give an existing operator a new password and end every session they hold.
 *
 * For the case a rotation usually answers: a credential that went somewhere it
 * should not have. Changing the password alone would leave whoever already has
 * a cookie signed in, so this does both.
 *
 *   OPERATOR_EMAIL=sam@example.com \
 *   OPERATOR_PASSWORD='<new password>' \
 *   ROTATION_REASON='Password was exposed in a transcript' \
 *   npx tsx scripts/rotate-operator-password.ts
 *
 * With no OPERATOR_PASSWORD a strong one is generated and printed once. Supply
 * one and nothing is printed, which is the right mode when the value must not
 * reach a log.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { parseDatabaseUrl } from '@/lib/database-safety';
import { DEMO_SEED_PASSWORD } from '@/lib/env';
import { SYSTEM_ACTOR } from '@/server/services/activity';
import { rotateOperatorPassword } from '@/server/services/auth';

const MIN_PASSWORD_LENGTH = 16;

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) fail('DATABASE_URL is not set.');

  const target = parseDatabaseUrl(url);
  if (target.kind !== 'unknown') {
    fail(`This is the ${target.kind} database ("${target.name}"). This tool is for a deployment.`);
  }

  const email = (process.env.OPERATOR_EMAIL ?? '').trim();
  if (!email) fail('OPERATOR_EMAIL is required.');
  const reason = (process.env.ROTATION_REASON ?? '').trim();
  if (!reason) fail('ROTATION_REASON is required, and ends up in the activity history.');

  const supplied = process.env.OPERATOR_PASSWORD;
  if (supplied !== undefined) {
    if (supplied === DEMO_SEED_PASSWORD) fail('OPERATOR_PASSWORD is the shared demo password.');
    if (supplied.length < MIN_PASSWORD_LENGTH) {
      fail(`OPERATOR_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
  }
  const password = supplied ?? randomBytes(18).toString('base64url');

  const result = await rotateOperatorPassword(prisma, SYSTEM_ACTOR, {
    email,
    newPassword: password,
    reason,
  });

  console.log(`\n  Rotated the password on ${target.redactedUrl}\n`);
  console.log(`    email             ${email}`);
  console.log(`    sessions ended    ${result.sessionsRevoked}`);
  if (!supplied) {
    console.log(`\n    password  ${password}`);
    console.log('\n  Shown once. Send it out of band and have them keep it.');
  }
  console.log('');
}

main()
  .catch((error) => {
    console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
