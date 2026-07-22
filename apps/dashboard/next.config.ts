import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  transpilePackages: ['@project-x/ui', '@project-x/shared', '@project-x/types'],
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname, '../..'),
};

export default nextConfig;
