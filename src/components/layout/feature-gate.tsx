'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Eye, Lock, ShieldOff, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { FEATURE_INFO, featureForPath, isFeature, type Feature } from '@/lib/features';
import { VIEW_ONLY_AREAS, areaForPath, isArea, type Area } from '@/lib/auth/permissions';

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
  const { hasFeature, can } = useAuth();
  const tp = useTranslations('Permissions');
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

  // Custom roles (062): no access → explain; view-only → say so once.
  const area = areaForPath(pathname);
  if (area && !can(area)) return <NoAccess area={area} />;
  const viewOnly = area && !VIEW_ONLY_AREAS.includes(area) && !can(area, 'edit');
  const noAccessKey = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('no_access');
  const blockedFrom = isArea(noAccessKey) && dismissed !== `${pathname}:${noAccessKey}` ? noAccessKey : null;

  return (
    <>
      {blockedFrom && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/50 p-3 text-sm">
          <div className="flex items-start gap-2">
            <ShieldOff className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-foreground">{tp('redirected', { area: tp(`areas.${blockedFrom}.label`) })}</span>
          </div>
          <button
            type="button"
            aria-label={t('dismiss')}
            onClick={() => setDismissed(`${pathname}:${blockedFrom}`)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {viewOnly && <ViewOnlyNotice area={area} />}
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

/** "Your role doesn't include this" (custom roles, migration 062). */
export function NoAccess({ area }: { area: Area }) {
  const t = useTranslations('Permissions');
  const { access } = useAuth();
  return (
    <div className="mx-auto mt-16 max-w-md rounded-xl border border-border bg-card p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <ShieldOff className="h-5 w-5 text-muted-foreground" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-foreground">{t('noAccessTitle')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('noAccessDesc', { area: t(`areas.${area}.label`), role: access?.name ?? '' })}
      </p>
    </div>
  );
}

/** Thin notice above a page the caller's role can only view. */
export function ViewOnlyNotice({ area }: { area: Area }) {
  const t = useTranslations('Permissions');
  const { access } = useAuth();
  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
      <Eye className="h-3.5 w-3.5 shrink-0" />
      <span>{t('viewOnly', { area: t(`areas.${area}.label`), role: access?.name ?? '' })}</span>
    </div>
  );
}
