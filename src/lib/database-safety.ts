/**
 * Fail-closed guards for destructive database operations.
 *
 * Two things in this repository truncate tables: `prisma/seed.ts` and the test
 * helper `truncateAll`. Both are legitimate against the right database and
 * catastrophic against the wrong one, and neither can tell from the inside
 * which it is talking to. This module is the single place that decides.
 *
 * The design is fail-closed: a database whose name is not recognisably a
 * development, test or end-to-end database is refused, rather than allowed
 * because nothing matched a deny list. A deny list would have to anticipate
 * every production name; an allow list only has to know the three we use.
 */
export type DatabaseKind = 'development' | 'test' | 'e2e' | 'unknown';

/** Exact names this repository owns. Anything else is `unknown`. */
const KNOWN_DATABASES: Record<string, DatabaseKind> = {
  expertops: 'development',
  expertops_test: 'test',
  expertops_e2e: 'e2e',
};

export interface ParsedDatabase {
  kind: DatabaseKind;
  name: string;
  host: string;
  /** The URL with any password replaced, safe to print or log. */
  redactedUrl: string;
}

export function parseDatabaseUrl(url: string): ParsedDatabase {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `DATABASE_URL is not a valid URL, so its target cannot be identified. Refusing to continue.`,
    );
  }

  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const redacted = new URL(url);
  if (redacted.password) redacted.password = '***';

  // A name that looks like a test database but is not one of ours is still
  // treated as a test database: someone has deliberately named it that way.
  const kind: DatabaseKind =
    KNOWN_DATABASES[name] ?? (/(^|[_-])(test|e2e)([_-]|$)/i.test(name) ? 'test' : 'unknown');

  return { kind, name, host: parsed.host, redactedUrl: redacted.toString() };
}

export interface DestructiveGuardOptions {
  /** What is about to happen, used in the refusal message. */
  operation: string;
  /** Which kinds of database this operation may target. */
  allow: DatabaseKind[];
  url?: string;
  /**
   * Set when an operator has explicitly accepted the risk for an unrecognised
   * database, e.g. `npm run db:seed -- --i-know-what-im-doing`.
   */
  acknowledgedUnknown?: boolean;
}

/**
 * Refuse a destructive operation unless the target is demonstrably safe.
 *
 * Throws with a message that names the database and says what to do instead,
 * because the usual cause is a stray `DATABASE_URL` in the shell rather than a
 * bug in the code.
 */
export function assertDestructiveAllowed(options: DestructiveGuardOptions): ParsedDatabase {
  const url = options.url ?? process.env.DATABASE_URL ?? '';
  if (!url) {
    throw new Error(`DATABASE_URL is not set. Refusing to ${options.operation}.`);
  }

  // Nothing destructive, ever, in a production build. This check comes first so
  // it cannot be bypassed by a permissive `allow` list.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `Refusing to ${options.operation}: NODE_ENV is "production". ` +
        'This operation destroys data and has no production use.',
    );
  }

  const target = parseDatabaseUrl(url);

  if (target.kind === 'unknown') {
    if (!options.acknowledgedUnknown) {
      throw new Error(
        `Refusing to ${options.operation} on database "${target.name}" at ${target.host}: ` +
          'the name is not one this project recognises ' +
          `(${Object.keys(KNOWN_DATABASES).join(', ')}), and unrecognised databases are refused ` +
          'rather than assumed safe. Check DATABASE_URL in your shell and .env.',
      );
    }
    return target;
  }

  if (!options.allow.includes(target.kind)) {
    throw new Error(
      `Refusing to ${options.operation} on the ${target.kind} database "${target.name}". ` +
        `This operation is only permitted on: ${options.allow.join(', ')}.`,
    );
  }

  return target;
}

/** Convenience for messages that should never contain credentials. */
export function redactDatabaseUrl(url: string | undefined): string {
  if (!url) return '(unset)';
  try {
    return parseDatabaseUrl(url).redactedUrl;
  } catch {
    return '(unparseable)';
  }
}
