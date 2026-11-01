import type { MetadataRoute } from 'next';

import { SITE_URL } from '@/lib/site';

// The public landing page is indexable; the app, its APIs and the auth
// pages are not (they are also marked noindex in the app layout).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/dashboard',
          '/inbox',
          '/contacts',
          '/pipelines',
          '/broadcasts',
          '/automations',
          '/flows',
          '/journeys',
          '/agents',
          '/callbacks',
          '/button-clicks',
          '/failed-messages',
          '/notifications',
          '/settings',
          '/carousels',
          '/admin',
          '/join/',
          '/login',
          '/signup',
          '/forgot-password',
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
