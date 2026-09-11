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
};

export default nextConfig;
