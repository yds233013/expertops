/**
 * Create the first operator on a deployment.
 *
 * ExpertOps has no public registration, on purpose: an operator account is a
 * staff account, and an open sign-up form on a staging box is an invitation.
 * The first account is therefore created by somebody with shell access to the
 * host, once, and every account after that is created by an operator who is
 * already signed in.
 *
 *   BOOTSTRAP_OPERATOR_EMAIL=ops@example.com \
 *   BOOTSTRAP_OPERATOR_NAME="Ada Ferris" \
 *   npx tsx scripts/bootstrap-operator.ts
 *
 * With no BOOTSTRAP_OPERATOR_PASSWORD a strong one is generated and printed
 * once. It is never written to a file and never logged again.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { parseDatabaseUrl } from '@/lib/database-safety';
import { DEMO_SEED_PASSWORD } from '@/lib/env';
import { createOperator } from '@/server/services/auth';

const MIN_PASSWORD_LENGTH = 16;

function generatePassword(): string {
  // base64url of 18 bytes: 24 characters, no shell-hostile punctuation.
  return randomBytes(18).toString('base64url');
}

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
      `This is the ${target.kind} database ("${target.name}"). Bootstrapping is for a deployment; ` +
        'use `npm run db:seed` for local demo accounts.',
    );
  }

  const email = (process.env.BOOTSTRAP_OPERATOR_EMAIL ?? '').trim();
  const name = (process.env.BOOTSTRAP_OPERATOR_NAME ?? '').trim();
  if (!email) fail('BOOTSTRAP_OPERATOR_EMAIL is required.');
  if (!name) fail('BOOTSTRAP_OPERATOR_NAME is required.');

  // "First operator" is the whole security story here: this command is only
  // safe because it refuses to run once anybody can sign in and create
  // accounts through the application.
  const existing = await prisma.user.count();
  if (existing > 0) {
    fail(
      `${existing} operator account(s) already exist. Create further accounts by signing in, ` +
        'not by running this script.',
    );
  }

  const supplied = process.env.BOOTSTRAP_OPERATOR_PASSWORD;
  if (supplied !== undefined) {
    if (supplied === DEMO_SEED_PASSWORD) {
      fail('BOOTSTRAP_OPERATOR_PASSWORD is the shared demo password from .env.example.');
    }
    if (supplied.length < MIN_PASSWORD_LENGTH) {
      fail(`BOOTSTRAP_OPERATOR_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
  }
  const password = supplied ?? generatePassword();

  const user = await createOperator(prisma, { email, name, password, role: 'ADMIN' });

  console.log(`\n  Created the first operator on ${target.redactedUrl}\n`);
  console.log(`    email  ${user.email}`);
  console.log(`    name   ${user.name}`);
  console.log(`    role   ${user.role}`);
  if (supplied === undefined) {
    console.log(`\n    password  ${password}`);
    console.log('\n  This is the only time it is shown. Put it in a password manager now.');
  }
  console.log('\n  Sign in, then create the rest of the team from the application.\n');
}

main()
  .catch((error) => {
    console.error(
      `\n  Bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
