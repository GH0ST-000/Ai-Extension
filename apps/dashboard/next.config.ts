import type { NextConfig } from 'next';
import path from 'node:path';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
let apiOrigin = 'http://localhost:3001';
try {
  apiOrigin = new URL(apiUrl).origin;
} catch {
  // keep default
}

const isProd = process.env.NODE_ENV === 'production';

/**
 * Production CSP — allow self, API origin, Paddle.js, and Sentry ingest.
 * Theme boot uses a tiny inline script; Next may also inject inline for hydration.
 * Prefer hashes/nonces in a later hardening pass if Next nonce plumbing is adopted.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `connect-src 'self' ${apiOrigin} https://*.sentry.io https://*.ingest.sentry.io https://api.paddle.com https://sandbox-api.paddle.com`,
  "img-src 'self' data: blob: https://cdn.paddle.com",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  isProd
    ? "script-src 'self' 'unsafe-inline' https://cdn.paddle.com https://sandbox-cdn.paddle.com"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.paddle.com https://sandbox-cdn.paddle.com",
  'upgrade-insecure-requests',
]
  .join('; ')
  .replace(/\s+/g, ' ')
  .trim();

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  ...(isProd
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
];

const nextConfig: NextConfig = {
  transpilePackages: ['@project-x/ui', '@project-x/shared', '@project-x/types'],
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname, '../..'),
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
