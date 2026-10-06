'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Lock, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { FEATURE_INFO, featureForPath, isFeature, type Feature } from '@/lib/features';

/**
 * Client-side half of the feature entitlements (migration 045).
 *
 * The middleware already redirects page loads of a switched-off
 * feature to /dashboard?feature_disabled=<key>; this covers client-side
 * navigations that render from cache, and explains the redirect.
 */
export function FeatureGate({ children }: { children: React.ReactNode }) {
  const t = useTranslations('FeatureGate');
  const pathname = usePathname();
  const { hasFeature } = useAuth();
  const [dismissed, setDismissed] = useState<string | null>(null);

  // Read from the URL during render rather than useSearchParams, which
  // would force a Suspense boundary around the whole dashboard. Pages
  // only render client-side after auth resolves, so there's no SSR
  // markup to mismatch; usePathname re-renders us on navigation.
  const key =
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('feature_disabled');
  const redirectedFrom =
    isFeature(key) && dismissed !== `${pathname}:${key}` ? FEATURE_INFO[key].label : null;

  const feature = featureForPath(pathname);
  if (feature && !hasFeature(feature)) return <FeatureUnavailable feature={feature} />;

  return (
    <>
      {redirectedFrom && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/50 p-3 text-sm">
          <div className="flex items-start gap-2">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-foreground">{t('description', { feature: redirectedFrom })}</span>
          </div>
          <button
            type="button"
            aria-label={t('dismiss')}
            onClick={() => setDismissed(`${pathname}:${key}`)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {children}
    </>
  );
}

/** "Not enabled for your account" notice for a switched-off feature. */
export function FeatureUnavailable({ feature }: { feature: Feature }) {
  const t = useTranslations('FeatureGate');
  return (
    <div className="mx-auto mt-16 max-w-md rounded-xl border border-border bg-card p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Lock className="h-5 w-5 text-muted-foreground" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-foreground">{t('title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('description', { feature: FEATURE_INFO[feature].label })}
      </p>
    </div>
  );
}
