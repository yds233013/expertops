import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],
  eslint: {
    // Linting is run explicitly via `npm run lint` in CI / the verify script.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
