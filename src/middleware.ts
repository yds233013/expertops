import { NextResponse, type NextRequest } from 'next/server';
import { CSRF_COOKIE } from '@/lib/csrf-constants';
import { generateEdgeToken, signEdgeToken } from '@/server/http/csrf-edge';

/**
 * Issue a CSRF token cookie to any browser that does not already hold one.
 *
 * Running here rather than in a layout means the cookie exists before the first
 * client-side mutation, including on the login page, and covers the expert and
 * candidate portals without a second implementation.
 *
 * The middleware only ever *adds* a cookie. Rejection happens in the request
 * guards, where the session is already being resolved.
 */
export async function middleware(request: NextRequest) {
  const response = NextResponse.next();

  if (!request.cookies.get(CSRF_COOKIE)?.value) {
    const secret = process.env.AUTH_SECRET;
    if (secret) {
      response.cookies.set(CSRF_COOKIE, await signEdgeToken(generateEdgeToken(), secret), {
        httpOnly: false, // the client must read it to echo it back in a header
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 60 * 24,
      });
    }
  }

  return response;
}

export const config = {
  // Everything except Next.js internals and static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
