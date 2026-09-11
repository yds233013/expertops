import { spawn, type ChildProcess } from 'node:child_process';
import { execSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';
import { assertDestructiveAllowed } from '../../src/lib/database-safety';
import {
  acquireSuiteLock,
  describeLockHolder,
  type SuiteLockHandle,
} from '../../src/lib/suite-lock';
import { resetAndSeedE2E } from './fixtures';

loadEnv();

let lock: SuiteLockHandle | null = null;
let worker: ChildProcess | null = null;

/** Shared with the teardown, which runs in the same process. */
export function e2eState() {
  return { lock, worker };
}

export default async function globalSetup(): Promise<void> {
  const databaseUrl =
    process.env.E2E_DATABASE_URL ??
    'postgresql://expertops:expertops@localhost:5433/expertops_e2e?schema=public';

  // Refuse before anything destructive happens. A stray DATABASE_URL in the
  // shell must not be able to turn a browser run into a development wipe.
  const target = assertDestructiveAllowed({
    operation: 'reset the database for the browser suite',
    allow: ['e2e'],
    url: databaseUrl,
  });

  // Serialise against any other destructive process on this database.
  lock = await acquireSuiteLock({
    holder: describeLockHolder('playwright'),
    databaseUrl,
    waitMs: 120_000,
  });

  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  await resetAndSeedE2E(databaseUrl);

  // A real worker process, not an inline drain: the journey depends on jobs the
  // worker performs (screening invitations, reviewer assignment, outbox sends).
  const port = process.env.E2E_PORT ?? '3100';
  worker = spawn('npx', ['tsx', 'src/server/worker/main.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'development',
      // Portal links written into the simulated outbox must point at the
      // browser-suite server, not at a development server on another port.
      APP_BASE_URL: `http://127.0.0.1:${port}`,
    },
    stdio: 'ignore',
    detached: false,
  });

  console.log(`  browser suite database: ${target.name} (${target.kind})`);
  console.log(`  worker pid ${worker.pid}, lock held by ${lock.holder}`);
}
