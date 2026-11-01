import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import '../globals.css';

// Root layout for the public site (the landing page at "/"). Kept separate
// from the app's root layout — (app)/layout.tsx — so visitors don't
// download the dashboard's translation catalogue, theme provider, toasts
// and dialogs. Route groups don't change URLs.

const inter = Inter({ variable: '--font-sans', subsets: ['latin'], display: 'swap' });

export const metadata: Metadata = {
  applicationName: 'Flowza',
  formatDetection: { email: false, address: false, telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#0d1117',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function SiteLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN" data-mode="dark" className={`${inter.variable} antialiased`}>
      <body className="bg-[#0d1117] font-sans">{children}</body>
    </html>
  );
}
