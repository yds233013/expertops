import 'dotenv/config';
import { assertDestructiveAllowed } from '@/lib/database-safety';
import {
  acquireSuiteLock,
  describeLockHolder,
  INHERITED_LOCK_ENV,
  type SuiteLockHandle,
} from '@/lib/suite-lock';

/**
 * Vitest global setup.
 *
 * Runs once per suite invocation, before any test file. Two jobs:
 *
 *  1. Refuse to start at all unless the target is a test database. `truncateAll`
 *     checks this too, but checking here means a misconfigured run fails in one
 *     line instead of part-way through the first file.
 *  2. Hold the destructive-operation lock for the whole run, so a concurrent
 *     `npm run db:seed` or a second `npm test` waits instead of truncating this
 *     run's fixtures out from under it.
 */
let lock: SuiteLockHandle | null = null;

export async function setup(): Promise<void> {
  const databaseUrl =
    process.env.TEST_DATABASE_URL ??
    'postgresql://expertops:expertops@localhost:5433/expertops_test?schema=public';

  // The suite only ever talks to this URL; setup.ts installs it per worker too.
  process.env.DATABASE_URL = databaseUrl;

  const target = assertDestructiveAllowed({
    operation: 'run the test suite (it truncates every table)',
    allow: ['test', 'e2e'],
    url: databaseUrl,
  });

  lock = await acquireSuiteLock({
    holder: describeLockHolder('vitest'),
    databaseUrl,
  });

  // Child processes the suite spawns on purpose (the seed test runs
  // prisma/seed.ts) inherit this lock instead of waiting for it.
  process.env[INHERITED_LOCK_ENV] = lock.holder;

  console.log(`  test database: ${target.name} (${target.kind}), lock held by ${lock.holder}`);
}

export async function teardown(): Promise<void> {
  delete process.env[INHERITED_LOCK_ENV];
  await lock?.release();
  lock = null;
}
