import { e2eState } from './global-setup';

/**
 * Stop only what this suite started.
 *
 * The worker is the child process spawned in setup; nothing else is signalled,
 * so a development worker or server running alongside is untouched.
 */
export default async function globalTeardown(): Promise<void> {
  const { lock, worker } = e2eState();
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM');
    await new Promise((resolve) => {
      worker.once('exit', resolve);
      setTimeout(resolve, 5_000);
    });
  }
  await lock?.release();
}
