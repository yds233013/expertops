import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * The browser suite builds into its own directory.
   *
   * Without this, running the e2e build would overwrite `.next` underneath a
   * development server that is already serving from it.
   */
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
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
