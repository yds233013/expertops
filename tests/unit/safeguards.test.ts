import { afterEach, describe, expect, it } from 'vitest';
import {
  configurationProblems,
  DEMO_AUTH_SECRET,
  DEMO_SEED_PASSWORD,
  deploymentEnvironment,
  type Env,
} from '@/lib/env';
import { redactFields, redactMessage, REDACTED } from '@/lib/log-redaction';
import { createLogger, newCorrelationId, withLogContext, currentLogContext } from '@/lib/logger';

/**
 * Safeguards that can be checked without a database.
 *
 * Two of the three exist because the failure they prevent is silent: a demo
 * secret signs real sessions perfectly well, and a token in a log line does not
 * announce itself until somebody reads the log.
 */
function env(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db/app',
    APP_BASE_URL: 'https://expertops.example',
    AUTH_SECRET: 'a'.repeat(48),
    SESSION_TTL_HOURS: 12,
    PORTAL_TOKEN_TTL_HOURS: 168,
    INVITATION_DEFAULT_TTL_HOURS: 72,
    WORKER_POLL_INTERVAL_MS: 1000,
    WORKER_BATCH_SIZE: 5,
    WORKER_LOCK_TIMEOUT_SECONDS: 120,
    WORKER_NAME: 'worker',
    EXPOSE_PORTAL_LINKS_IN_UI: false,
    SEED_DEMO_PASSWORD: 'a-real-one',
    EXPERTOPS_ENV: undefined,
    ...overrides,
  } as Env;
}

describe('production configuration guard', () => {
  it('accepts a configuration that was actually set up', () => {
    expect(configurationProblems(env())).toEqual([]);
  });

  it('refuses the placeholder auth secret', () => {
    const problems = configurationProblems(env({ AUTH_SECRET: DEMO_AUTH_SECRET }));
    expect(problems.join(' ')).toMatch(/AUTH_SECRET is still the placeholder/);
  });

  it('refuses a short secret even if it is not the placeholder', () => {
    expect(configurationProblems(env({ AUTH_SECRET: 'short-but-not-demo' })).join(' ')).toMatch(
      /at least 32 characters/,
    );
  });

  it('refuses the shared demo password', () => {
    expect(
      configurationProblems(env({ SEED_DEMO_PASSWORD: DEMO_SEED_PASSWORD })).join(' '),
    ).toMatch(/demo password/i);
  });

  it('refuses to print magic links in a production UI', () => {
    expect(configurationProblems(env({ EXPOSE_PORTAL_LINKS_IN_UI: true })).join(' ')).toMatch(
      /single-use magic links/,
    );
  });

  it('refuses plain HTTP for anything but localhost', () => {
    expect(
      configurationProblems(env({ APP_BASE_URL: 'http://expertops.example' })).join(' '),
    ).toMatch(/unencrypted/);
    expect(configurationProblems(env({ APP_BASE_URL: 'http://localhost:3000' }))).toEqual([]);
  });

  it('treats a production build running as a test deployment as a test', () => {
    // `next start` forces NODE_ENV=production for the browser suite too, which
    // runs locally against a throwaway database with development settings on
    // purpose. The deployment is what the checks care about.
    const browserSuite = env({
      NODE_ENV: 'production',
      EXPERTOPS_ENV: 'test',
      AUTH_SECRET: DEMO_AUTH_SECRET,
      SEED_DEMO_PASSWORD: DEMO_SEED_PASSWORD,
      EXPOSE_PORTAL_LINKS_IN_UI: true,
      APP_BASE_URL: 'http://127.0.0.1:3100',
    });
    expect(configurationProblems(browserSuite)).toEqual([]);
    expect(deploymentEnvironment(browserSuite)).toBe('test');

    // And a real deployment still gets every check, without setting anything.
    expect(deploymentEnvironment(env({ EXPERTOPS_ENV: undefined }))).toBe('production');
  });

  it('says nothing outside production, where these are the intended settings', () => {
    const development = env({
      NODE_ENV: 'development',
      AUTH_SECRET: DEMO_AUTH_SECRET,
      SEED_DEMO_PASSWORD: DEMO_SEED_PASSWORD,
      EXPOSE_PORTAL_LINKS_IN_UI: true,
      APP_BASE_URL: 'http://localhost:3000',
    });
    expect(configurationProblems(development)).toEqual([]);
  });

  it('refuses a deployment pointed at the development or test database', () => {
    expect(
      configurationProblems(
        env({ DATABASE_URL: 'postgresql://ops:secret@db:5432/expertops?schema=public' }),
      ).join(' '),
    ).toMatch(/development database "expertops"/);

    expect(
      configurationProblems(env({ DATABASE_URL: 'postgresql://ops:secret@db:5432/expertops_test' }))
        .join(' ')
        .toLowerCase(),
    ).toContain('test database');

    // A database of its own is what it is asking for.
    expect(
      configurationProblems(
        env({ DATABASE_URL: 'postgresql://ops:secret@db:5432/expertops_staging' }),
      ),
    ).toEqual([]);
  });

  it('refuses the development database credentials', () => {
    expect(
      configurationProblems(
        env({ DATABASE_URL: 'postgresql://expertops:expertops@db:5432/expertops_staging' }),
      ).join(' '),
    ).toMatch(/development database credentials/);
  });

  it('reports every problem at once rather than one per restart', () => {
    const problems = configurationProblems(
      env({
        AUTH_SECRET: DEMO_AUTH_SECRET,
        SEED_DEMO_PASSWORD: DEMO_SEED_PASSWORD,
        EXPOSE_PORTAL_LINKS_IN_UI: true,
      }),
    );
    expect(problems.length).toBe(3);
  });
});

describe('log redaction', () => {
  it('removes credentials by field name', () => {
    const safe = redactFields({
      email: 'rosa@example.test',
      password: 'hunter2',
      authSecret: 'sk-live-abc',
      sessionToken: 'abcdef',
      cookie: 'expertops_session=xyz',
    })!;
    expect(safe.email).toBe('rosa@example.test');
    expect(safe.password).toBe(REDACTED);
    expect(safe.authSecret).toBe(REDACTED);
    expect(safe.sessionToken).toBe(REDACTED);
    expect(safe.cookie).toBe(REDACTED);
    expect(JSON.stringify(safe)).not.toContain('hunter2');
  });

  it('does not redact an error message, which is an operational fact', () => {
    // This was a real regression: `message` matched the body rule, so a stack
    // trace an operator needed read "[redacted] (57 chars)".
    const safe = redactFields({
      message: "Cannot read properties of undefined (reading 'findFirst')",
    })!;
    expect(safe.message).toMatch(/findFirst/);
  });

  it('keeps the length of a message body but not the body', () => {
    const safe = redactFields({ bodyText: 'Dear Rosa, your screening is ready.' })!;
    expect(safe.bodyText).toMatch(/redacted.*35 chars/);
    expect(JSON.stringify(safe)).not.toContain('Dear Rosa');
  });

  it('strips the token from a magic link wherever it appears', () => {
    const link = 'http://localhost:3000/apply/enter#t=ZZ-SECRET-TOKEN-123456789';
    const safe = redactFields({ url: link, note: 'x' })!;
    expect(safe.url).toBe('http://localhost:3000/apply/enter#[redacted]');
    expect(JSON.stringify(safe)).not.toContain('ZZ-SECRET-TOKEN');

    // Including the old path-shaped form, in case one is ever constructed again.
    expect(redactMessage('opened http://h/portal/enter/ZZ-SECRET-TOKEN-9')).toBe(
      'opened http://h/portal/enter#[redacted]',
    );
  });

  it('reaches into nested objects and arrays', () => {
    const safe = redactFields({
      outer: { inner: { password: 'p', ok: 1 } },
      links: ['https://h/apply/enter#t=SECRET', 'https://h/dashboard'],
    })!;
    const outer = safe.outer as Record<string, Record<string, unknown>>;
    expect(outer.inner!.password).toBe(REDACTED);
    expect(safe.links).toEqual(['https://h/apply/enter#[redacted]', 'https://h/dashboard']);
  });

  it('stops at a sane depth rather than recursing forever', () => {
    const deep = { a: { b: { c: { d: { e: { password: 'p' } } } } } };
    expect(() => redactFields(deep)).not.toThrow();
  });
});

describe('correlation ids', () => {
  const lines: string[] = [];
  const original = console.log;

  afterEach(() => {
    console.log = original;
    lines.length = 0;
  });

  it('tags every line produced inside a context, and redacts at the same time', () => {
    console.log = (line: string) => void lines.push(line);
    process.env.LOG_LEVEL = 'info';

    const log = createLogger('test');
    const id = newCorrelationId();
    withLogContext({ correlationId: id, source: 'http', operation: 'POST /x' }, () => {
      log.info('handled', { password: 'hunter2', url: 'https://h/apply/enter#t=SECRET' });
      expect(currentLogContext()?.correlationId).toBe(id);
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(id);
    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).not.toContain('SECRET');
    delete process.env.LOG_LEVEL;
  });

  it('does not leak a context between unrelated operations', () => {
    const first = withLogContext(
      { correlationId: 'aaa' },
      () => currentLogContext()?.correlationId,
    );
    const outside = currentLogContext();
    expect(first).toBe('aaa');
    expect(outside).toBeUndefined();
  });
});
