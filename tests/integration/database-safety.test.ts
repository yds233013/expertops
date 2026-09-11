import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDestructiveAllowed,
  parseDatabaseUrl,
  redactDatabaseUrl,
} from '@/lib/database-safety';
import {
  acquireSuiteLock,
  INHERITED_LOCK_ENV,
  inspectSuiteLock,
  type SuiteLockHandle,
} from '@/lib/suite-lock';
import { assertTestDatabase } from '../helpers/db';

/**
 * Guards against destroying the wrong database.
 *
 * A real collision happened during development: a manual `prisma/seed.ts` run
 * truncated `expertops_test` while the suite was mid-run, producing a failure
 * that looked like a product bug and vanished on a rerun. These tests cover the
 * two things that were missing then — a guard on the seed, and a lock between
 * destructive processes — because "it passed the second time" proves nothing.
 */
const DEV = 'postgresql://u:p@localhost:5433/expertops?schema=public';
const TEST = 'postgresql://u:p@localhost:5433/expertops_test?schema=public';
const E2E = 'postgresql://u:p@localhost:5433/expertops_e2e?schema=public';
const UNKNOWN = 'postgresql://u:p@db.internal:5432/customer_records';

describe('database classification', () => {
  it('recognises the three databases this project owns', () => {
    expect(parseDatabaseUrl(DEV).kind).toBe('development');
    expect(parseDatabaseUrl(TEST).kind).toBe('test');
    expect(parseDatabaseUrl(E2E).kind).toBe('e2e');
  });

  it('treats anything else as unknown rather than assuming it is safe', () => {
    expect(parseDatabaseUrl(UNKNOWN).kind).toBe('unknown');
    expect(parseDatabaseUrl('postgresql://u:p@h/prod').kind).toBe('unknown');
    expect(parseDatabaseUrl('postgresql://u:p@h/expertops_staging').kind).toBe('unknown');
  });

  it('accepts a deliberately test-named database it has not seen before', () => {
    // Someone naming a database "..._test" has said what it is for.
    expect(parseDatabaseUrl('postgresql://u:p@h/someones_test').kind).toBe('test');
    expect(parseDatabaseUrl('postgresql://u:p@h/ci_e2e_db').kind).toBe('test');
  });

  it('never returns a password in the redacted form', () => {
    const redacted = redactDatabaseUrl('postgresql://user:hunter2@localhost:5433/expertops');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('***');
    expect(redacted).toContain('expertops');
  });

  it('refuses a URL it cannot parse rather than guessing', () => {
    expect(() => parseDatabaseUrl('not a url')).toThrow(/cannot be identified/);
    expect(redactDatabaseUrl('not a url')).toBe('(unparseable)');
    expect(redactDatabaseUrl(undefined)).toBe('(unset)');
  });
});

describe('the destructive-operation guard fails closed', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
  });

  it('refuses an unrecognised database even when the allow list is permissive', () => {
    expect(() =>
      assertDestructiveAllowed({
        operation: 'truncate',
        allow: ['development', 'test', 'e2e'],
        url: UNKNOWN,
      }),
    ).toThrow(/not one this project recognises/);
  });

  it('refuses the development database for a test-only operation', () => {
    expect(() =>
      assertDestructiveAllowed({ operation: 'run tests', allow: ['test', 'e2e'], url: DEV }),
    ).toThrow(/development database "expertops"/);
  });

  it('refuses everything in a production build, whatever the allow list says', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    for (const url of [DEV, TEST, E2E]) {
      expect(() =>
        assertDestructiveAllowed({
          operation: 'truncate',
          allow: ['development', 'test', 'e2e'],
          url,
        }),
      ).toThrow(/NODE_ENV is "production"/);
    }
  });

  it('refuses when DATABASE_URL is absent', () => {
    expect(() =>
      assertDestructiveAllowed({ operation: 'truncate', allow: ['test'], url: '' }),
    ).toThrow(/not set/);
  });

  it('allows an explicit acknowledgement for an unknown database', () => {
    // This is the escape hatch for someone running against their own database.
    // It must be opt-in and impossible to hit by accident.
    const target = assertDestructiveAllowed({
      operation: 'truncate',
      allow: ['test'],
      url: UNKNOWN,
      acknowledgedUnknown: true,
    });
    expect(target.kind).toBe('unknown');
  });

  it('permits the intended combinations', () => {
    expect(
      assertDestructiveAllowed({ operation: 'seed', allow: ['development'], url: DEV }).name,
    ).toBe('expertops');
    expect(
      assertDestructiveAllowed({ operation: 'test', allow: ['test', 'e2e'], url: TEST }).name,
    ).toBe('expertops_test');
    expect(
      assertDestructiveAllowed({ operation: 'browser test', allow: ['e2e'], url: E2E }).name,
    ).toBe('expertops_e2e');
  });

  it('holds the real destructive lock for the whole suite run', async () => {
    // globalSetup took it before any test file loaded. A concurrent seed or a
    // second `npm test` therefore waits instead of truncating these fixtures.
    const held = await inspectSuiteLock(process.env.DATABASE_URL!);
    expect(held).not.toBeNull();
    expect(held!.holder).toMatch(/^vitest:/);
  });

  it('is the same guard the test helper uses', () => {
    expect(() => assertTestDatabase(DEV)).toThrow(/development database/);
    expect(() => assertTestDatabase(UNKNOWN)).toThrow(/not one this project recognises/);
    expect(() => assertTestDatabase(TEST)).not.toThrow();
  });
});

describe('the suite lock serialises destructive processes', () => {
  const url = process.env.DATABASE_URL!;
  const handles: SuiteLockHandle[] = [];
  // The running suite already holds the real destructive lock (globalSetup),
  // so these tests exercise the mechanism in their own namespace.
  const lockId = 'test-namespace';

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.release()));
  });

  it('blocks a second holder while the first is working', async () => {
    const first = await acquireSuiteLock({ holder: 'race-A', databaseUrl: url, lockId });
    handles.push(first);

    const started = Date.now();
    await expect(
      acquireSuiteLock({ holder: 'race-B', databaseUrl: url, waitMs: 1000, lockId }),
    ).rejects.toThrow(/Timed out .* waiting for/);

    // It waited rather than failing instantly, which is what lets a short
    // overlap resolve itself.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('names the current holder so a stuck run can be diagnosed', async () => {
    const first = await acquireSuiteLock({ holder: 'race-named', databaseUrl: url, lockId });
    handles.push(first);

    const held = await inspectSuiteLock(url, lockId);
    expect(held?.holder).toBe('race-named');

    await expect(
      acquireSuiteLock({ holder: 'race-other', databaseUrl: url, waitMs: 600, lockId }),
    ).rejects.toThrow(/race-named/);
  });

  it('hands the lock over once the holder releases', async () => {
    const first = await acquireSuiteLock({ holder: 'race-first', databaseUrl: url, lockId });
    await first.release();
    expect(await inspectSuiteLock(url, lockId)).toBeNull();

    const second = await acquireSuiteLock({
      holder: 'race-second',
      databaseUrl: url,
      waitMs: 2000,
      lockId,
    });
    handles.push(second);
    expect((await inspectSuiteLock(url, lockId))?.holder).toBe('race-second');
  });

  it('releasing twice is harmless', async () => {
    const handle = await acquireSuiteLock({ holder: 'race-double', databaseUrl: url, lockId });
    await handle.release();
    await expect(handle.release()).resolves.toBeUndefined();
  });

  it('lets a child of the holder inherit the lock instead of waiting', async () => {
    // This is exactly what the seed test needs: the suite holds the lock, then
    // deliberately runs prisma/seed.ts against the same database.
    const holder = await acquireSuiteLock({ holder: 'race-parent', databaseUrl: url, lockId });
    handles.push(holder);

    process.env[INHERITED_LOCK_ENV] = 'race-parent';
    try {
      const child = await acquireSuiteLock({
        holder: 'race-child',
        databaseUrl: url,
        waitMs: 1000,
        lockId,
      });
      expect(child.holder).toBe('race-parent');

      // Releasing the inherited handle must not free the parent's lock.
      await child.release();
      expect((await inspectSuiteLock(url, lockId))?.holder).toBe('race-parent');
    } finally {
      delete process.env[INHERITED_LOCK_ENV];
    }
  });

  it('ignores a claimed inheritance that does not match the real holder', async () => {
    const holder = await acquireSuiteLock({ holder: 'race-real', databaseUrl: url, lockId });
    handles.push(holder);

    process.env[INHERITED_LOCK_ENV] = 'race-pretender';
    try {
      await expect(
        acquireSuiteLock({ holder: 'race-other', databaseUrl: url, waitMs: 800, lockId }),
      ).rejects.toThrow(/race-real/);
    } finally {
      delete process.env[INHERITED_LOCK_ENV];
    }
  });

  it('does not let a released holder delete a successor row', async () => {
    const first = await acquireSuiteLock({ holder: 'race-one', databaseUrl: url, lockId });
    await first.release();

    const second = await acquireSuiteLock({ holder: 'race-two', databaseUrl: url, lockId });
    handles.push(second);

    // A late release from the previous holder must not free the new one's lock.
    await first.release();
    expect((await inspectSuiteLock(url, lockId))?.holder).toBe('race-two');
  });
});
