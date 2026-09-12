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
  /**
   * Which environment this *deployment* is, as opposed to how the code was
   * built.
   *
   * `next start` forces `NODE_ENV=production` for any production build,
   * including the one the browser suite runs locally against a throwaway
   * database. Those are not the same thing, and the safety checks below care
   * about the deployment, not the build. Defaults to `NODE_ENV`, so a real
   * deployment gets the checks without setting anything.
   *
   * Setting this to anything but `production` on a real deployment is an
   * operator switching off their own safety check.
   */
  EXPERTOPS_ENV: z.enum(['development', 'test', 'production']).optional(),
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
    EXPERTOPS_ENV: process.env.EXPERTOPS_ENV,
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

  assertSafeForMode(parsed.data);
  cached = parsed.data;
  return cached;
}

/**
 * Values that ship in `.env.example` and must never reach a real deployment.
 *
 * The check is on the literal shipped values rather than on entropy: a secret
 * chosen badly is the operator's decision to make, but a secret nobody chose at
 * all is a packaging accident, and it is the one this build can recognise with
 * certainty.
 */
export const DEMO_AUTH_SECRET = 'dev-only-insecure-secret-change-me-0000000000000000000000000000';
export const DEMO_SEED_PASSWORD = 'demo-password-123';

export class InsecureConfigurationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(
      `Refusing to start in production with development configuration:\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}\n\nSee docs/operations.md for what each value needs to be.`,
    );
    this.name = 'InsecureConfigurationError';
    this.problems = problems;
  }
}

/**
 * Refuse to start a production build on demo settings.
 *
 * Each of these is safe in development and dangerous in production, and none of
 * them announces itself at runtime: a demo secret signs real sessions perfectly
 * well, and an exposed portal link looks like a feature until somebody forwards
 * one. Failing at boot is the only point where it is cheap.
 */
export function deploymentEnvironment(env: Env): 'development' | 'test' | 'production' {
  return env.EXPERTOPS_ENV ?? env.NODE_ENV;
}

export function configurationProblems(env: Env): string[] {
  if (deploymentEnvironment(env) !== 'production') return [];
  const problems: string[] = [];

  if (env.AUTH_SECRET === DEMO_AUTH_SECRET) {
    problems.push(
      'AUTH_SECRET is still the placeholder from .env.example. Generate one with `openssl rand -hex 32`.',
    );
  }
  if (env.AUTH_SECRET.length < 32) {
    problems.push('AUTH_SECRET must be at least 32 characters in production.');
  }
  if (env.SEED_DEMO_PASSWORD === DEMO_SEED_PASSWORD) {
    problems.push(
      'SEED_DEMO_PASSWORD is the shared demo password. Seeded demo accounts must not exist in production.',
    );
  }
  if (env.EXPOSE_PORTAL_LINKS_IN_UI) {
    problems.push(
      'EXPOSE_PORTAL_LINKS_IN_UI prints single-use magic links in the operator UI. It must be false in production.',
    );
  }
  if (env.APP_BASE_URL.startsWith('http://') && !env.APP_BASE_URL.includes('localhost')) {
    problems.push(
      `APP_BASE_URL is plain HTTP (${env.APP_BASE_URL}). Session and portal links would travel unencrypted.`,
    );
  }
  return problems;
}

function assertSafeForMode(env: Env): void {
  const problems = configurationProblems(env);
  if (problems.length > 0) throw new InsecureConfigurationError(problems);
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
