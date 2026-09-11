import 'dotenv/config';

/**
 * Point every test at the dedicated test database.
 *
 * This runs before any module that reads DATABASE_URL, so the Prisma client
 * built in `src/lib/db.ts` connects to `expertops_test` and never to the
 * development database.
 */
// `NODE_ENV` is declared readonly by @types/node. Tests genuinely do need to
// set it before any module reads it, so the cast is deliberate and local.
(process.env as Record<string, string | undefined>).NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://expertops:expertops@localhost:5433/expertops_test?schema=public';
process.env.AUTH_SECRET ??= 'test-only-secret-0000000000000000000000000000000000';
process.env.APP_BASE_URL ??= 'http://localhost:3000';
process.env.EXPOSE_PORTAL_LINKS_IN_UI = 'true';
process.env.LOG_LEVEL ??= 'silent';
