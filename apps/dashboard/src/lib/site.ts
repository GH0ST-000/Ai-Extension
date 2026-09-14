import type { Metadata } from 'next';

import { APP_NAME } from '@project-x/shared';

/** Public marketing / studio origin. Prefer NEXT_PUBLIC_APP_URL in deployed environments. */
export function getSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through
    }
  }

  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) {
    const host = vercel.replace(/^https?:\/\//, '');
    return `https://${host}`;
  }

  return 'http://localhost:3000';
}

export const SITE_NAME = APP_NAME;

export const SITE_TAGLINE = 'AI that reads the page with you.';

export const SITE_DESCRIPTION =
  'Project X is a Chrome extension and studio for contextual AI on any page — selection actions, GitHub reviews, Jira alignment, and OpenAPI analysis with confirmed writes only.';

export const SITE_KEYWORDS = [
  'Project X',
  'Chrome extension AI',
  'contextual AI',
  'GitHub AI reviews',
  'Jira AI',
  'OpenAPI analysis',
  'selection toolbar',
  'engineering AI assistant',
  'browser AI',
] as const;

export const NO_INDEX_ROBOTS = {
  index: false,
  follow: false,
  googleBot: {
    index: false,
    follow: false,
  },
} as const satisfies Metadata['robots'];

export function absoluteUrl(pathname = '/'): string {
  const base = getSiteUrl().replace(/\/$/, '');
  if (!pathname || pathname === '/') {
    return `${base}/`;
  }
  return `${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

export function buildSocialMetadata(options?: {
  title?: string;
  description?: string;
  path?: string;
}): Pick<Metadata, 'openGraph' | 'twitter' | 'alternates'> {
  const title = options?.title ?? `${SITE_NAME} — ${SITE_TAGLINE}`;
  const description = options?.description ?? SITE_DESCRIPTION;
  const path = options?.path ?? '/';
  const url = absoluteUrl(path);

  return {
    alternates: {
      canonical: path,
    },
    openGraph: {
      type: 'website',
      locale: 'en_US',
      url,
      siteName: SITE_NAME,
      title,
      description,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  };
}
