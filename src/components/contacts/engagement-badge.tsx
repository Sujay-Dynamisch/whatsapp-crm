'use client';

import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { computeEngagement, type EngagementSignals } from '@/lib/smart-sending/engagement';

const TIER_CLASS = {
  engaged: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400',
  warm: 'bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400',
  cold: 'bg-slate-500/10 text-muted-foreground border-slate-500/20',
} as const;

/**
 * Engagement tier (+ "resting") for a contact (migration 048). Renders
 * nothing unless smart sending is enabled for the account. Uses the
 * default rest policy — the account's own thresholds apply when a
 * broadcast is built.
 */
export function EngagementBadge({
  contact,
  showScore = false,
  className,
}: {
  contact: EngagementSignals;
  showScore?: boolean;
  className?: string;
}) {
  const t = useTranslations('SmartSending.badge');
  const { hasFeature } = useAuth();
  if (!hasFeature('smart_sending')) return null;

  const e = computeEngagement(contact);
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      <span
        title={t('scoreTitle', { score: e.score })}
        className={cn(
          'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
          TIER_CLASS[e.tier]
        )}
      >
        {t(e.tier)}
        {showScore ? ` · ${e.score}` : ''}
      </span>
      {e.resting && (
        <span
          title={t(`restReason.${e.restReason}`)}
          className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400"
        >
          {t('resting')}
        </span>
      )}
    </span>
  );
}
