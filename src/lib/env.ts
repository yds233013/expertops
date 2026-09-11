import { z } from 'zod';

/**
 * Environment parsing.
 *
 * Deliberately strict: a missing DATABASE_URL or AUTH_SECRET should fail loudly
 * at boot rather than at the first query. Values that only matter in
 * development get safe defaults so `npm test` works without a full .env.
 */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  AUTH_SECRET: z.string().min(16, 'AUTH_SECRET must be at least 16 characters'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  PORTAL_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(168),
  INVITATION_DEFAULT_TTL_HOURS: z.coerce.number().int().positive().default(72),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(5),
  WORKER_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  WORKER_NAME: z.string().default('local-worker'),
  EXPOSE_PORTAL_LINKS_IN_UI: booleanish.default(false),
  SEED_DEMO_PASSWORD: z.string().min(8).default('demo-password-123'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse({
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    APP_BASE_URL: process.env.APP_BASE_URL,
    AUTH_SECRET: process.env.AUTH_SECRET,
    SESSION_TTL_HOURS: process.env.SESSION_TTL_HOURS,
    PORTAL_TOKEN_TTL_HOURS: process.env.PORTAL_TOKEN_TTL_HOURS,
    INVITATION_DEFAULT_TTL_HOURS: process.env.INVITATION_DEFAULT_TTL_HOURS,
    WORKER_POLL_INTERVAL_MS: process.env.WORKER_POLL_INTERVAL_MS,
    WORKER_BATCH_SIZE: process.env.WORKER_BATCH_SIZE,
    WORKER_LOCK_TIMEOUT_SECONDS: process.env.WORKER_LOCK_TIMEOUT_SECONDS,
    WORKER_NAME: process.env.WORKER_NAME,
    EXPOSE_PORTAL_LINKS_IN_UI: process.env.EXPOSE_PORTAL_LINKS_IN_UI,
    SEED_DEMO_PASSWORD: process.env.SEED_DEMO_PASSWORD,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nDid you copy .env.example to .env?`,
    );
  }

  cached = parsed.data;
  return cached;
}

/** Test helper: forget the memoised env so a test can change process.env. */
export function resetEnvCache(): void {
  cached = null;
}

/**
 * Portal links may only be surfaced in the UI when this is a local development
 * build AND the operator explicitly opted in. Production builds always hide
 * them regardless of the flag.
 */
export function portalLinksVisible(): boolean {
  const env = getEnv();
  return env.NODE_ENV !== 'production' && env.EXPOSE_PORTAL_LINKS_IN_UI;
}
