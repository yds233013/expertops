/**
 * CSRF names shared by the server guard and the browser fetch wrapper.
 *
 * Kept in their own dependency-free module: the server implementation imports
 * `node:crypto`, and a client component importing these constants from there
 * would drag that into the browser bundle.
 */
export const CSRF_COOKIE = 'expertops_csrf';
export const CSRF_HEADER = 'x-csrf-token';
