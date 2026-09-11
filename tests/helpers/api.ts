import { NextRequest } from 'next/server';
import { type User } from '@prisma/client';
import { prisma } from '@/lib/db';
import { login } from '@/server/services/auth';
import { OPERATOR_COOKIE, PORTAL_COOKIE } from '@/server/http/context';
import { CSRF_COOKIE, CSRF_HEADER, generateCsrfToken, signCsrfToken } from '@/server/http/csrf';

/**
 * Drive route handlers directly.
 *
 * Route handlers read their cookies from the request rather than from async
 * storage, so a test can construct a NextRequest and call the exported GET/POST
 * with no Next.js server running.
 */
const BASE = 'http://localhost:3000';

export interface RequestOptions {
  body?: unknown;
  searchParams?: Record<string, string>;
  operatorToken?: string;
  portalToken?: string;
  headers?: Record<string, string>;
  /**
   * CSRF behaviour. Requests default to a well-formed same-origin submission,
   * which is what a real browser sends. Tests that exercise the protection
   * itself override these.
   */
  origin?: string | null;
  csrfCookie?: string | null;
  csrfHeader?: string | null;
}

export function buildRequest(
  method: string,
  path: string,
  options: RequestOptions = {},
): NextRequest {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }

  const cookies: string[] = [];
  if (options.operatorToken) cookies.push(`${OPERATOR_COOKIE}=${options.operatorToken}`);
  if (options.portalToken) cookies.push(`${PORTAL_COOKIE}=${options.portalToken}`);

  const headers = new Headers(options.headers ?? {});

  // A same-origin browser submission by default: matching Origin, a signed CSRF
  // cookie, and the same value echoed in the header.
  const csrfToken =
    options.csrfCookie === undefined ? signCsrfToken(generateCsrfToken()) : options.csrfCookie;
  if (csrfToken) cookies.push(`${CSRF_COOKIE}=${csrfToken}`);

  const headerValue = options.csrfHeader === undefined ? csrfToken : options.csrfHeader;
  if (headerValue) headers.set(CSRF_HEADER, headerValue);

  if (options.origin !== null) headers.set('origin', options.origin ?? BASE);
  headers.set('host', new URL(BASE).host);

  if (cookies.length > 0) headers.set('cookie', cookies.join('; '));
  if (options.body !== undefined) headers.set('content-type', 'application/json');

  return new NextRequest(url, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
  response: Response;
}

export async function callRoute<T = any>(
  handler: (request: NextRequest, context?: any) => Promise<Response>,
  request: NextRequest,
  params?: Record<string, string>,
): Promise<ApiResult<T>> {
  const response = await handler(request, params ? { params: Promise.resolve(params) } : undefined);
  let body: unknown = null;
  if (response.status !== 204) {
    const text = await response.clone().text();
    body = text ? JSON.parse(text) : null;
  }
  return { status: response.status, body: body as T, response };
}

/** Sign an operator in and return the raw session token for use in cookies. */
export async function operatorToken(user: User & { plainPassword: string }): Promise<string> {
  const result = await login(prisma, { email: user.email, password: user.plainPassword });
  return result.token;
}

export function cookieValue(response: Response, name: string): string | null {
  const header = response.headers.get('set-cookie');
  if (!header) return null;
  const match = new RegExp(`${name}=([^;]*)`).exec(header);
  return match?.[1] ?? null;
}
