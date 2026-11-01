// Public site identity for SEO, share previews and structured data.
//
// SITE_URL must be the canonical production origin (scheme + host, no
// trailing slash), e.g. https://flowza.in — set NEXT_PUBLIC_SITE_URL.
// Canonical links, the sitemap and the WhatsApp / social share image all
// use it, so a wrong value hurts ranking and breaks link previews.

export const SITE_NAME = 'Flowza';

function resolveSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit && !/crm\.example\.com/.test(explicit)) return explicit.replace(/\/+$/, '');
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel.replace(/\/+$/, '')}`;
  return 'http://localhost:3000';
}

export const SITE_URL = resolveSiteUrl();

export const SITE_TITLE = 'Flowza — WhatsApp CRM & Business Automation';
export const SITE_TAGLINE = 'Grow your business on WhatsApp, on autopilot.';
export const SITE_DESCRIPTION =
  'Automate WhatsApp follow-ups, payment reminders, appointment updates and campaigns. Shared team inbox, journeys, broadcasts, AI replies and custom roles on the official WhatsApp Business API — plans from ₹999/month.';

export const SITE_KEYWORDS = [
  'WhatsApp CRM',
  'WhatsApp automation',
  'WhatsApp Business API',
  'WhatsApp marketing India',
  'WhatsApp broadcast',
  'WhatsApp chatbot',
  'WhatsApp shared inbox',
  'payment reminders WhatsApp',
  'lead follow-up automation',
  'AiSensy alternative',
  'WATI alternative',
  'Flowza',
];
