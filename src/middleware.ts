import { NextResponse, type NextRequest } from 'next/server';
import { CSRF_COOKIE } from '@/lib/csrf-constants';
import { generateEdgeToken, signEdgeToken } from '@/server/http/csrf-edge';
import {
  GATE_CHALLENGE_HEADERS,
  gateAllows,
  gateCredentials,
  isGateExempt,
} from '@/server/http/staging-gate';

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
  // The shared outer gate, when a deployment configures one. It runs before
  // anything else so a stranger who finds the URL never reaches a login form,
  // a portal, or an API route. /api/health is exempt because the platform's
  // own health check cannot send credentials.
  const gate = gateCredentials({
    STAGING_GATE_USER: process.env.STAGING_GATE_USER,
    STAGING_GATE_PASSWORD: process.env.STAGING_GATE_PASSWORD,
  });
  if (gate && !isGateExempt(request.nextUrl.pathname)) {
    if (!gateAllows(request.headers.get('authorization'), gate)) {
      return new NextResponse('Authentication required.', {
        status: 401,
        headers: GATE_CHALLENGE_HEADERS,
      });
    }
  }

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
