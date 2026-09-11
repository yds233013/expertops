import { PrismaClient } from '@prisma/client';

/**
 * Single Prisma client per process.
 *
 * Next.js dev mode reloads modules on every edit, so the client is stashed on
 * `globalThis` to avoid exhausting PostgreSQL connections.
 */
const globalForPrisma = globalThis as unknown as { __expertopsPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__expertopsPrisma ??
  new PrismaClient({
    // Unique-violation errors are a normal, handled outcome in this codebase
    // (they are how concurrent writes are detected), so tests keep Prisma quiet
    // and let the assertions speak.
    log:
      process.env.PRISMA_LOG === 'query'
        ? ['query', 'warn', 'error']
        : process.env.NODE_ENV === 'test'
          ? []
          : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__expertopsPrisma = prisma;
}

/**
 * The type accepted by every business service: either the shared client or a
 * transaction handle. Services never reach for the global client directly,
 * which is what lets the HTTP layer and the worker compose them into larger
 * transactions.
 */
export type Db = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** PostgreSQL unique-violation code, used to turn races into domain errors. */
export const PG_UNIQUE_VIOLATION = 'P2002';
/** Prisma "record not found" for an update/delete. */
export const PG_RECORD_NOT_FOUND = 'P2025';

export function isPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * A client capable of opening a transaction.
 *
 * Services that need a row lock (staffing seat capacity) take this rather than
 * `Db`, because the lock and the write must be in one transaction to be a real
 * guard. Everything else takes `Db` so it can compose into a caller's
 * transaction.
 */
export type Transactor = Pick<PrismaClient, '$transaction'> & Db;

/**
 * Which column(s) a unique violation was on.
 *
 * Prisma puts the target in `meta.target`. Reporting it stops a conflict on one
 * field being explained to the user as a conflict on another, which is both
 * confusing and a real debugging cost.
 */
export function uniqueViolationTarget(error: unknown): string[] {
  if (!isPrismaErrorCode(error, PG_UNIQUE_VIOLATION)) return [];
  const meta = (error as { meta?: { target?: unknown } }).meta;
  const target = meta?.target;
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === 'string') return [target];
  return [];
}
