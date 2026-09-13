/**
 * A shared outer gate for a hosted staging deployment.
 *
 * On a self-hosted box this was Caddy's job. On a platform like Render there is
 * no reverse proxy of ours in front of the app: the service is on the public
 * internet the moment it deploys. The gate therefore has to live in the
 * application, and it runs in middleware so it covers every route — operator
 * screens, both participant portals, and the API — before any of them resolve a
 * session.
 *
 * It is one shared credential handed to invited testers. It identifies nobody
 * and authorises nothing: the operator sign-in and the single-use portal links
 * behind it are still what decide who someone is. Its whole job is that a
 * stranger who finds the URL sees a password prompt instead of a login form.
 *
 * Unset in development and in tests, where there is nothing to keep out.
 */

/** The one path that must answer without credentials. */
export const GATE_EXEMPT_PATHS = ['/api/health'];

export interface GateCredentials {
  user: string;
  password: string;
}

/**
 * The gate is on only when both halves are configured. A half-configured gate
 * that let everything through would be worse than no gate, because it would
 * look like one.
 */
export function gateCredentials(env: {
  STAGING_GATE_USER?: string;
  STAGING_GATE_PASSWORD?: string;
}): GateCredentials | null {
  const user = env.STAGING_GATE_USER?.trim();
  const password = env.STAGING_GATE_PASSWORD?.trim();
  if (!user || !password) return null;
  return { user, password };
}

export function isGateExempt(pathname: string): boolean {
  return GATE_EXEMPT_PATHS.includes(pathname);
}

/** Length-independent comparison, so a wrong password leaks no timing signal. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Does this Authorization header satisfy the gate?
 *
 * Deliberately tolerant about the scheme's casing and strict about everything
 * else. A malformed header is a failure, not an exception.
 */
export function gateAllows(
  authorization: string | null | undefined,
  credentials: GateCredentials,
): boolean {
  if (!authorization) return false;
  const [scheme, encoded] = authorization.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'basic' || !encoded) return false;

  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }

  // Only the first colon separates them: a password may contain colons.
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;

  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return (
    constantTimeEquals(user, credentials.user) && constantTimeEquals(password, credentials.password)
  );
}

export const GATE_CHALLENGE_HEADERS = {
  'WWW-Authenticate': 'Basic realm="ExpertOps staging", charset="UTF-8"',
  // A staging deployment has no business in a search index.
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
} as const;
