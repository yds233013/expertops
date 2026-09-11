import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getEnv } from '@/lib/env';
import { forbidden } from '@/lib/errors';
import { CSRF_HEADER } from '@/lib/csrf-constants';

/**
 * CSRF protection for cookie-authenticated mutations.
 *
 * Two independent checks, both required, applied to every state-changing
 * request that carries an operator session or an expert portal session:
 *
 *  1. **Origin / Referer check.** The request's origin must match the
 *     application's own origin. A cross-site form post or fetch carries either
 *     a foreign `Origin` or, for some legacy flows, none at all; both are
 *     rejected. This is the check that stops the classic attack.
 *
 *  2. **Double-submit token.** A random token is issued in a readable cookie
 *     and must be echoed in the `x-csrf-token` header. A cross-origin caller
 *     cannot read the cookie (same-origin policy), so it cannot produce the
 *     header. This catches cases where a browser omits Origin, and makes the
 *     protection explicit rather than relying on one header.
 *
 * `SameSite=Lax` on the session cookie is a useful third layer but is not
 * treated as sufficient: it does not cover same-site subdomain attackers, and
 * it is a browser behaviour rather than something the server verifies.
 */
export { CSRF_COOKIE, CSRF_HEADER } from '@/lib/csrf-constants';

/** Methods that cannot change state and therefore need no CSRF check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Bind the token to nothing but itself.
 *
 * The token's security comes from being unguessable and unreadable
 * cross-origin, so a plain random value is sufficient. It is signed so a
 * malformed or truncated cookie is rejected rather than silently compared.
 */
export function signCsrfToken(token: string): string {
  const mac = createHmac('sha256', getEnv().AUTH_SECRET).update(token).digest('base64url');
  return `${token}.${mac}`;
}

export function verifyCsrfSignature(signed: string): boolean {
  const separator = signed.lastIndexOf('.');
  if (separator <= 0) return false;
  const token = signed.slice(0, separator);
  const expected = signCsrfToken(token);
  return safeEquals(signed, expected);
}

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function csrfCookieOptions() {
  return {
    // Deliberately readable by same-origin JavaScript: the client has to echo
    // it back in a header. It is not a credential on its own.
    httpOnly: false,
    sameSite: 'lax' as const,
    path: '/',
    secure: getEnv().NODE_ENV === 'production',
    maxAge: 60 * 60 * 24,
  };
}

/** Origins the application will accept a mutation from. */
export function allowedOrigins(): string[] {
  const configured = getEnv().APP_BASE_URL.replace(/\/$/, '');
  const origins = new Set<string>([configured]);
  try {
    const url = new URL(configured);
    // Accept the same host on the port the request actually arrived on, so a
    // developer hitting 127.0.0.1 instead of localhost is not locked out.
    if (url.hostname === 'localhost') origins.add(`${url.protocol}//127.0.0.1:${url.port}`);
    if (url.hostname === '127.0.0.1') origins.add(`${url.protocol}//localhost:${url.port}`);
  } catch {
    // A malformed APP_BASE_URL is caught by env validation; nothing to add.
  }
  return [...origins];
}

export function originMatches(origin: string | null, host: string | null): boolean {
  if (!origin) return false;
  const normalised = origin.replace(/\/$/, '');
  if (allowedOrigins().includes(normalised)) return true;

  // Fall back to comparing against the Host header, which covers a developer
  // reaching the app on a LAN address not listed in APP_BASE_URL.
  if (!host) return false;
  try {
    return new URL(normalised).host === host;
  } catch {
    return false;
  }
}

export interface CsrfCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Run both checks against a request.
 *
 * Returns a result rather than throwing so callers can distinguish "no session,
 * nothing to protect" from "session present, request rejected".
 */
export function checkCsrf(request: Request, cookieToken: string | undefined): CsrfCheckResult {
  if (isSafeMethod(request.method)) return { ok: true };

  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const host = request.headers.get('host');

  // Prefer Origin; fall back to the Referer's origin when Origin is absent.
  let effectiveOrigin = origin;
  if (!effectiveOrigin && referer) {
    try {
      effectiveOrigin = new URL(referer).origin;
    } catch {
      effectiveOrigin = null;
    }
  }

  if (!effectiveOrigin) {
    return { ok: false, reason: 'The request carried no Origin or Referer header.' };
  }
  if (!originMatches(effectiveOrigin, host)) {
    return {
      ok: false,
      reason: `Origin ${effectiveOrigin} is not allowed to submit this request.`,
    };
  }

  const headerToken = request.headers.get(CSRF_HEADER);
  if (!headerToken) {
    return { ok: false, reason: `Missing ${CSRF_HEADER} header.` };
  }
  if (!cookieToken) {
    return { ok: false, reason: 'No CSRF cookie was presented.' };
  }
  if (!verifyCsrfSignature(cookieToken)) {
    return { ok: false, reason: 'The CSRF cookie is malformed.' };
  }
  if (!safeEquals(headerToken, cookieToken)) {
    return { ok: false, reason: 'The CSRF token did not match the cookie.' };
  }

  return { ok: true };
}

export function assertCsrf(request: Request, cookieToken: string | undefined): void {
  const result = checkCsrf(request, cookieToken);
  if (!result.ok) {
    throw forbidden(`Rejected for cross-site request forgery protection: ${result.reason}`);
  }
}
