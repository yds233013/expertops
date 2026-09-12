import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import { actorFor, makeExpert, makeOperator, makeProject } from '../helpers/factories';
import { enqueueJob } from '@/server/services/jobs';
import { createInvitation } from '@/server/services/invitations';

/**
 * A backup nobody has restored is a hypothesis.
 *
 * This runs the same two scripts an operator runs, against the test database,
 * and reads the restored copy to see what actually survived. Three things have
 * to come back or the backup is not a backup: the business records, the audit
 * history that explains them, and the queued work that has not happened yet.
 *
 * The restore goes into a uniquely named disposable database and drops it
 * afterwards. Neither the development database nor the test database is
 * touched by the restore.
 */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://expertops:expertops@localhost:5433/expertops_test?schema=public';

let workdir: string;

function run(script: string, args: string[]): string {
  return execFileSync(script, args, {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

describe('backup and restore', () => {
  beforeAll(() => {
    applyMigrations();
    workdir = mkdtempSync(join(tmpdir(), 'expertops-backup-'));
  });
  beforeEach(() => truncateAll());
  afterAll(() => {
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  });

  it('restores business records, audit history and queued work into a fresh database', async () => {
    // A small but representative world: records, the history explaining them,
    // and work that has been queued but not yet run.
    const operator = await makeOperator({ role: 'ADMIN' });
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert();
    await createInvitation(prisma, actorFor(operator), {
      projectId: project.id,
      expertId: expert.id,
    });
    const queued = await enqueueJob(prisma, {
      type: 'onboarding.start',
      payload: { expertId: expert.id },
      dedupeKey: `onboarding.start:backup-test-${expert.id}`,
    });

    const before = {
      experts: await prisma.expert.count(),
      projects: await prisma.project.count(),
      invitations: await prisma.invitation.count(),
      activity: await prisma.activityEvent.count(),
      queuedJobs: await prisma.job.count({ where: { status: { in: ['PENDING', 'FAILED'] } } }),
    };
    expect(before.activity).toBeGreaterThan(0);
    expect(before.queuedJobs).toBeGreaterThan(0);

    // Take the backup exactly as the runbook says to.
    const output = run('./scripts/backup.sh', [join(workdir, 'suite')]);
    const dump = /Wrote (\S+\.dump)/.exec(output)?.[1];
    expect(dump, output).toBeTruthy();

    // Restore into a disposable database and read what came back.
    const restored = run('./scripts/restore-check.sh', [dump!]);

    function counted(label: string): number {
      const match = new RegExp(`^${label} \\| (\\d+)$`, 'm').exec(restored);
      expect(match, `"${label}" missing from:\n${restored}`).toBeTruthy();
      return Number(match![1]);
    }

    expect(counted('experts')).toBe(before.experts);
    expect(counted('projects')).toBe(before.projects);
    expect(counted('audit history')).toBe(before.activity);
    expect(counted('queued jobs')).toBe(before.queuedJobs);
    // Migrations come back too, so the restored copy is a database the
    // application can actually start against rather than a pile of rows.
    expect(counted('applied migrations')).toBeGreaterThan(0);

    expect(restored).toMatch(/source database was never touched/);

    // The source is intact: restoring read from a file, not from here.
    expect(await prisma.expert.count()).toBe(before.experts);
    expect(await prisma.job.count({ where: { id: queued.job!.id } })).toBe(1);
  }, 120_000);

  it('refuses a corrupted backup rather than restoring half of it', async () => {
    await makeOperator();
    const output = run('./scripts/backup.sh', [join(workdir, 'corrupt')]);
    const dump = /Wrote (\S+\.dump)/.exec(output)![1]!;

    // Flip bytes in the middle of the archive, leaving the checksum sidecar as
    // it was: exactly what a truncated copy or a bad disk looks like.
    execFileSync('bash', [
      '-c',
      `printf 'corrupted' | dd of=${dump} bs=1 seek=2000 conv=notrunc status=none`,
    ]);

    let failed = false;
    try {
      run('./scripts/restore-check.sh', [dump]);
    } catch {
      failed = true;
    }
    // The checksum check catches it before any database is created.
    expect(failed).toBe(true);
  }, 120_000);
});
