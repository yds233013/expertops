'use client';

import { CSRF_COOKIE, CSRF_HEADER } from '@/lib/csrf-constants';

/**
 * Browser-side fetch wrapper.
 *
 * Every mutation from a client component goes through here so the CSRF token is
 * attached consistently. A component that calls `fetch` directly for a mutation
 * will be rejected by the server, which is the intended failure mode: it is
 * visible immediately rather than silently unprotected.
 */
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: ApiError | null;
}

export async function apiFetch<T = unknown>(
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const token = readCookie(CSRF_COOKIE);
  if (token) headers[CSRF_HEADER] = token;

  try {
    const response = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data: null,
        error: payload?.error ?? {
          code: 'UNKNOWN',
          message: `Request failed (${response.status}).`,
        },
      };
    }
    return { ok: true, status: response.status, data: payload as T, error: null };
  } catch {
    return {
      ok: false,
      status: 0,
      data: null,
      error: { code: 'NETWORK', message: 'Could not reach the server.' },
    };
  }
}

/** Convenience wrappers so call sites read as the verb they are. */
export const apiPost = <T = unknown>(url: string, body?: unknown) =>
  apiFetch<T>(url, { method: 'POST', body });
export const apiPatch = <T = unknown>(url: string, body?: unknown) =>
  apiFetch<T>(url, { method: 'PATCH', body });
export const apiDelete = <T = unknown>(url: string) => apiFetch<T>(url, { method: 'DELETE' });
export const apiGet = <T = unknown>(url: string) => apiFetch<T>(url);
