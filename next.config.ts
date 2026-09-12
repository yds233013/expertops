import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * Three builds, three directories.
   *
   * `next build` used to write to `.next`, the very directory a running
   * `next dev` serves from, so building while developing replaced the dev
   * server's compiled routes with production output it could not use — routes
   * started returning 500 until the dev server was reloaded.
   *
   * | Mode | Directory | Set by |
   * | --- | --- | --- |
   * | `npm run dev` | `.next-dev` | the `dev` script |
   * | `npm run build` / `npm start` | `.next-prod` | the `build` and `start` scripts |
   * | `npm run e2e` | `.next-e2e` | the `e2e:server` script |
   *
   * The scripts set `NEXT_DIST_DIR` explicitly so the choice does not depend on
   * how `NODE_ENV` happens to be resolved. The fallback below covers a bare
   * `npx next …` and still keeps development and production apart.
   */
  distDir:
    process.env.NEXT_DIST_DIR ??
    (process.env.NODE_ENV === 'production' ? '.next-prod' : '.next-dev'),
  poweredByHeader: false,
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],
  eslint: {
    // Linting is run explicitly via `npm run lint` in CI / the verify script.
    ignoreDuringBuilds: true,
  },

  /**
   * Referrer policy.
   *
   * Magic-link tokens travel in the URL fragment, which browsers never put in a
   * `Referer` header, so this is defence in depth rather than the primary
   * control. `no-referrer` on the two portal trees means a page reached from a
   * link forwards nothing at all, even if a future change puts something in a
   * query string. The rest of the application keeps the browser default, which
   * the CSRF guard can still fall back on when `Origin` is absent.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }],
      },
      {
        source: '/apply/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        source: '/portal/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
    ];
  },
};

export default nextConfig;
