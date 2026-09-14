import { exerciseState } from './global-setup';

/** Stop the worker this suite started. The network itself is left standing. */
export default async function globalTeardown(): Promise<void> {
  const { worker } = exerciseState();
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM');
    await new Promise((resolve) => {
      worker.once('exit', resolve);
      setTimeout(resolve, 5_000);
    });
  }
}
