import type { Metadata } from 'next';

import { LandingPage } from '@/components/landing/landing-page';

// Signed-in users are sent to the dashboard by the middleware; everyone
// else gets the landing page.
export const metadata: Metadata = {
  title: { absolute: 'wacrm — WhatsApp CRM & business automation' },
  description:
    'Automate WhatsApp follow-ups, payment reminders, appointment updates and campaigns. Shared inbox, journeys, broadcasts, AI and custom roles — plans from ₹999/month.',
  robots: { index: true, follow: true },
  openGraph: {
    title: 'wacrm — Grow your business on WhatsApp, on autopilot',
    description: 'Shared inbox, automated journeys, broadcasts, AI replies and custom roles on the official WhatsApp Business API.',
    type: 'website',
  },
};

export default function RootPage() {
  return <LandingPage />;
}
