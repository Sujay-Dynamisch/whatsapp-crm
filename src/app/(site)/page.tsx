import type { Metadata } from 'next';

import { LandingPage } from '@/components/landing/landing-page';
import { CONTACT, FAQS, PLANS } from '@/components/landing/content';
import { SITE_DESCRIPTION, SITE_KEYWORDS, SITE_NAME, SITE_TITLE, SITE_URL } from '@/lib/site';

// Signed-in users are sent to the dashboard by the middleware; everyone
// else gets the landing page. The share image comes from
// ./opengraph-image.tsx (Next adds the og:image / twitter:image tags).
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { absolute: `${SITE_TITLE} | Plans from ₹999/month` },
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  applicationName: SITE_NAME,
  alternates: { canonical: '/' },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 } },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: SITE_NAME,
    locale: 'en_IN',
    title: `${SITE_NAME} — Grow your business on WhatsApp, on autopilot`,
    description: 'Shared team inbox, automated follow-ups & payment reminders, broadcasts, AI replies and custom roles — on the official WhatsApp Business API. Plans from ₹999/month.',
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} — WhatsApp CRM & Business Automation`,
    description: 'Automate follow-ups, reminders and campaigns on WhatsApp. Plans from ₹999/month.',
  },
  category: 'business',
};

/** Structured data for Google (organisation, product with INR prices, FAQ). */
function jsonLd() {
  const paid = PLANS.filter((p) => p.amount);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#organization`,
        name: SITE_NAME,
        url: `${SITE_URL}/`,
        logo: `${SITE_URL}/brand/flowza-circle-512.png`,
        contactPoint: {
          '@type': 'ContactPoint',
          telephone: `+${CONTACT.phone}`,
          contactType: 'sales',
          areaServed: 'IN',
          availableLanguage: ['en'],
        },
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        url: `${SITE_URL}/`,
        name: SITE_NAME,
        inLanguage: 'en-IN',
        publisher: { '@id': `${SITE_URL}/#organization` },
      },
      {
        '@type': 'SoftwareApplication',
        name: SITE_NAME,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        description: SITE_DESCRIPTION,
        url: `${SITE_URL}/`,
        publisher: { '@id': `${SITE_URL}/#organization` },
        offers: {
          '@type': 'AggregateOffer',
          priceCurrency: 'INR',
          lowPrice: Math.min(...paid.map((p) => p.amount!)),
          highPrice: Math.max(...paid.map((p) => p.amount!)),
          offerCount: paid.length,
          offers: paid.map((p) => ({
            '@type': 'Offer',
            name: `${p.name} plan`,
            price: p.amount,
            priceCurrency: 'INR',
            priceSpecification: { '@type': 'UnitPriceSpecification', price: p.amount, priceCurrency: 'INR', unitText: 'MONTH' },
          })),
        },
      },
      {
        '@type': 'FAQPage',
        mainEntity: FAQS.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
    ],
  };
}

export default function RootPage() {
  return (
    <>
      <script
        type="application/ld+json"
        // JSON only (no user input); "<" escaped so it can't close the tag.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd()).replace(/</g, '\\u003c') }}
      />
      <LandingPage />
    </>
  );
}
