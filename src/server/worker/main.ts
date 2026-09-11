/**
 * Worker entrypoint: `npm run worker` (watch) or `npm run worker:start`.
 *
 * Pass `--once` to run a single tick and exit, which is what the smoke script
 * and the demo walkthrough use to drain the queue deterministically.
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import { createLogger } from '@/lib/logger';
import { Worker } from './runner';
import { workerConfig } from './handlers';

const log = createLogger('worker:main');

async function main() {
  const once = process.argv.includes('--once');
  const drain = process.argv.includes('--drain');
  const config = workerConfig();

  const worker = new Worker({
    client: prisma,
    name: config.name,
    batchSize: config.batchSize,
    lockTimeoutSeconds: config.lockTimeoutSeconds,
    pollIntervalMs: config.pollIntervalMs,
  });

  if (once || drain) {
    await worker.bootstrap();
    if (drain) {
      // Keep ticking until nothing is claimed, with a hard stop so a
      // continuously failing job cannot loop forever.
      for (let pass = 0; pass < 50; pass += 1) {
        const summary = await worker.tick();
        log.info(`drain pass ${pass + 1}`, { ...summary });
        if (summary.jobsClaimed === 0) break;
      }
    } else {
      const summary = await worker.tick();
      log.info('single tick complete', { ...summary });
    }
    await prisma.$disconnect();
    return;
  }

  const shutdown = (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    worker.stop();
    setTimeout(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    }, 250);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await worker.start();
  await prisma.$disconnect();
}

main().catch(async (error) => {
  log.error('worker crashed', { error: error instanceof Error ? error.message : String(error) });
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
