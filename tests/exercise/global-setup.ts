import { spawn, type ChildProcess } from 'node:child_process';
import { config as loadEnv } from 'dotenv';
import { parseDatabaseUrl } from '../../src/lib/database-safety';

loadEnv();

let worker: ChildProcess | null = null;

export function exerciseState() {
  return { worker };
}

/**
 * Start a worker, and nothing else.
 *
 * Deliberately no reset and no seed. The network this suite drives was built by
 * `scripts/network-exercise.ts` and must still be there when the run finishes.
 * The only guard is a refusal to point at development by accident.
 */
export default async function globalSetup(): Promise<void> {
  const databaseUrl =
    process.env.EXERCISE_DATABASE_URL ??
    'postgresql://expertops:expertops@localhost:5433/expertops_exercise?schema=public';

  const target = parseDatabaseUrl(databaseUrl);
  if (target.kind === 'development') {
    throw new Error(
      `Refusing to run the exercise suite against the development database "${target.name}".`,
    );
  }

  const port = process.env.EXERCISE_PORT ?? '3200';
  worker = spawn('npx', ['tsx', 'src/server/worker/main.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'development',
      APP_BASE_URL: `http://127.0.0.1:${port}`,
    },
    stdio: 'ignore',
    detached: false,
  });

  console.log(`  exercise database: ${target.name} (${target.kind})`);
  console.log(`  worker pid ${worker.pid}`);
}
