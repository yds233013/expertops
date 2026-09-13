/**
 * Add an operator account to a deployment, after the first one.
 *
 * There is no account-management screen in the application: `user:manage`
 * exists as a capability and nothing uses it yet. Without this, a deployment
 * could have exactly one operator — the one `bootstrap-operator.ts` creates —
 * and every tester would have to share it, which would make the activity
 * history lie about who did what.
 *
 * Run it from the host, as somebody who already has shell access:
 *
 *   OPERATOR_EMAIL=sam@example.com \
 *   OPERATOR_NAME="Sam Okafor" \
 *   OPERATOR_ROLE=OPERATOR \
 *   npx tsx scripts/create-operator.ts
 *
 * Roles: VIEWER (read-only), OPERATOR (day-to-day), ADMIN (approvals that need
 * a second person). Give ADMIN to at least two people or nothing can be
 * approved, and to as few as possible beyond that.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { type UserRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { parseDatabaseUrl } from '@/lib/database-safety';
import { DEMO_SEED_PASSWORD } from '@/lib/env';
import { createOperator } from '@/server/services/auth';

const MIN_PASSWORD_LENGTH = 16;
const ROLES: UserRole[] = ['VIEWER', 'OPERATOR', 'ADMIN'];

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
      `This is the ${target.kind} database ("${target.name}"). This tool is for a deployment; ` +
        'development has `npm run db:seed`.',
    );
  }

  const email = (process.env.OPERATOR_EMAIL ?? '').trim();
  const name = (process.env.OPERATOR_NAME ?? '').trim();
  const role = (process.env.OPERATOR_ROLE ?? 'OPERATOR').trim().toUpperCase() as UserRole;
  if (!email) fail('OPERATOR_EMAIL is required.');
  if (!name) fail('OPERATOR_NAME is required.');
  if (!ROLES.includes(role)) fail(`OPERATOR_ROLE must be one of ${ROLES.join(', ')}.`);

  // The first account is a different job, with a different guarantee.
  const existing = await prisma.user.count();
  if (existing === 0) {
    fail('No operator exists yet. Run scripts/bootstrap-operator.ts for the first one.');
  }

  const supplied = process.env.OPERATOR_PASSWORD;
  if (supplied !== undefined) {
    if (supplied === DEMO_SEED_PASSWORD) fail('OPERATOR_PASSWORD is the shared demo password.');
    if (supplied.length < MIN_PASSWORD_LENGTH) {
      fail(`OPERATOR_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
  }
  const password = supplied ?? randomBytes(18).toString('base64url');

  const user = await createOperator(prisma, { email, name, password, role });

  console.log(`\n  Added an operator on ${target.redactedUrl}\n`);
  console.log(`    email  ${user.email}`);
  console.log(`    name   ${user.name}`);
  console.log(`    role   ${user.role}`);
  if (supplied === undefined) {
    console.log(`\n    password  ${password}`);
    console.log('\n  Shown once. Send it to them out of band and have them keep it.');
  }
  console.log('');
}

main()
  .catch((error) => {
    console.error(`\n  Failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
