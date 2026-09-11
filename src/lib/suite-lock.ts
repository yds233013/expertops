import { PrismaClient } from '@prisma/client';
import { parseDatabaseUrl } from './database-safety';

/**
 * A cross-process lock on a whole database.
 *
 * The problem it solves: `prisma/seed.ts` and the test suites both truncate
 * every table. Run two of them at once against the same database and the second
 * one wipes the first one's fixtures mid-run, producing a failure that looks
 * like a product bug and disappears on a rerun. That is exactly what happened
 * once during development, and "it passed the second time" is not evidence of
 * isolation.
 *
 * Implementation notes:
 *
 *  * The lock lives in its own table, created with `CREATE TABLE IF NOT EXISTS`
 *    outside the Prisma schema. It therefore survives `truncateAll` (which
 *    lists tables explicitly) and is not something a migration can drop.
 *  * A PostgreSQL advisory lock would be tidier, but advisory locks are
 *    session-scoped and Prisma pools connections, so the release could land on
 *    a different connection than the acquire. A row is boring and correct.
 *  * Locks carry a heartbeat. A holder that crashes leaves a stale row, which
 *    the next acquirer takes over after `STALE_AFTER_MS` rather than deadlocking
 *    the repository forever.
 */
const LOCK_TABLE = '_expertops_suite_lock';

/**
 * The lock every destructive process competes for.
 *
 * Tests that exercise the locking mechanism itself pass their own id, so they
 * do not contend with the lock the running suite already holds.
 */
export const DESTRUCTIVE_LOCK_ID = 'destructive';

/**
 * How a lock holder hands its lock to a child process.
 *
 * The test suite holds the lock for the whole run and then deliberately spawns
 * `prisma/seed.ts` against the same test database. That child must not wait for
 * a lock its own parent is holding. Setting this variable says "I am running
 * inside the holder", and it is only honoured when the value actually matches
 * the holder recorded in the database, so it cannot be used to jump a queue.
 */
export const INHERITED_LOCK_ENV = 'EXPERTOPS_SUITE_LOCK_HOLDER';

export const STALE_AFTER_MS = 5 * 60_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_WAIT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

interface LockRow {
  holder: string;
  acquired_at: Date;
  heartbeat_at: Date;
}

export interface SuiteLockHandle {
  holder: string;
  release: () => Promise<void>;
}

async function ensureTable(client: PrismaClient): Promise<void> {
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${LOCK_TABLE}" (
      "id" text PRIMARY KEY,
      "holder" text NOT NULL,
      "acquired_at" timestamptz NOT NULL DEFAULT now(),
      "heartbeat_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Take the lock, waiting for a current holder to finish.
 *
 * Returns a handle whose `release` is safe to call more than once.
 */
export async function acquireSuiteLock(options: {
  holder: string;
  databaseUrl?: string;
  waitMs?: number;
  /** Lock namespace. Defaults to the shared destructive-operation lock. */
  lockId?: string;
}): Promise<SuiteLockHandle> {
  const url = options.databaseUrl ?? process.env.DATABASE_URL ?? '';
  const target = parseDatabaseUrl(url);
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const lockId = options.lockId ?? DESTRUCTIVE_LOCK_ID;

  const client = new PrismaClient({ datasources: { db: { url } }, log: [] });
  await ensureTable(client);

  const inherited = process.env[INHERITED_LOCK_ENV];
  if (inherited) {
    const current = await client.$queryRawUnsafe<LockRow[]>(
      `SELECT "holder", "acquired_at", "heartbeat_at" FROM "${LOCK_TABLE}" WHERE "id" = $1`,
      lockId,
    );
    if (current[0]?.holder === inherited) {
      await client.$disconnect().catch(() => undefined);
      // Releasing is the parent's job; this handle deliberately does nothing.
      return { holder: inherited, release: async () => undefined };
    }
  }

  const deadline = Date.now() + waitMs;
  let acquired = false;

  while (!acquired) {
    // Insert if free, or take over a row whose holder stopped reporting in.
    const rows = await client.$executeRawUnsafe(
      `
      INSERT INTO "${LOCK_TABLE}" ("id", "holder", "acquired_at", "heartbeat_at")
      VALUES ($1, $2, now(), now())
      ON CONFLICT ("id") DO UPDATE
        SET "holder" = EXCLUDED."holder",
            "acquired_at" = now(),
            "heartbeat_at" = now()
        WHERE "${LOCK_TABLE}"."heartbeat_at" < now() - ($3::int * interval '1 millisecond')
      `,
      lockId,
      options.holder,
      STALE_AFTER_MS,
    );

    if (rows > 0) {
      acquired = true;
      break;
    }

    if (Date.now() > deadline) {
      const current = await client.$queryRawUnsafe<LockRow[]>(
        `SELECT "holder", "acquired_at", "heartbeat_at" FROM "${LOCK_TABLE}" WHERE "id" = $1`,
        lockId,
      );
      const holder = current[0]?.holder ?? 'an unknown process';
      await client.$disconnect();
      throw new Error(
        `Timed out after ${Math.round(waitMs / 1000)}s waiting for the ${target.name} database. ` +
          `"${holder}" is holding the destructive-operation lock. ` +
          'Wait for it to finish, or if it has crashed, wait ' +
          `${Math.round(STALE_AFTER_MS / 60_000)} minutes for the lock to go stale.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  // Keep the row fresh so a long suite is not mistaken for a crashed one.
  const heartbeat = setInterval(() => {
    void client
      .$executeRawUnsafe(
        `UPDATE "${LOCK_TABLE}" SET "heartbeat_at" = now() WHERE "id" = $1 AND "holder" = $2`,
        lockId,
        options.holder,
      )
      .catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  let released = false;
  return {
    holder: options.holder,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      // Only delete our own row, so a takeover of a stale lock is not undone
      // by the process that lost it.
      await client
        .$executeRawUnsafe(
          `DELETE FROM "${LOCK_TABLE}" WHERE "id" = $1 AND "holder" = $2`,
          lockId,
          options.holder,
        )
        .catch(() => undefined);
      await client.$disconnect().catch(() => undefined);
    },
  };
}

/** Who currently holds the lock, if anyone. Used by diagnostics and tests. */
export async function inspectSuiteLock(
  databaseUrl?: string,
  lockId: string = DESTRUCTIVE_LOCK_ID,
): Promise<{ holder: string; acquiredAt: Date; heartbeatAt: Date } | null> {
  const url = databaseUrl ?? process.env.DATABASE_URL ?? '';
  const client = new PrismaClient({ datasources: { db: { url } }, log: [] });
  try {
    await ensureTable(client);
    const rows = await client.$queryRawUnsafe<LockRow[]>(
      `SELECT "holder", "acquired_at", "heartbeat_at" FROM "${LOCK_TABLE}" WHERE "id" = $1`,
      lockId,
    );
    const row = rows[0];
    return row
      ? { holder: row.holder, acquiredAt: row.acquired_at, heartbeatAt: row.heartbeat_at }
      : null;
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

export function describeLockHolder(prefix: string): string {
  return `${prefix}:pid-${process.pid}:${Date.now().toString(36)}`;
}
