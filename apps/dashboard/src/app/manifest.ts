import type { MetadataRoute } from 'next';

import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE } from '../lib/site';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: `${SITE_TAGLINE} ${SITE_DESCRIPTION}`,
    start_url: '/',
    display: 'standalone',
    background_color: '#F4F7FB',
    theme_color: '#0B1220',
    icons: [
      {
        src: '/brand/mark.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/brand/mark.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}
