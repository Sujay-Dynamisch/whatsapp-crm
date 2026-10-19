'use client';

import { Gauge } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import {
  DEFAULT_ENGAGEMENT_FILTER,
  ENGAGEMENT_FILTERS,
  type EngagementFilter,
} from '@/lib/smart-sending/engagement';

/**
 * Who to leave out of a broadcast based on engagement (migration 048).
 * Resting = Meta limited them recently (131049) or they ignored several
 * broadcasts in a row — sending more mostly costs money and quality.
 */
export function EngagementFilterPicker({
  value,
  onChange,
}: {
  value: EngagementFilter | undefined;
  onChange: (value: EngagementFilter) => void;
}) {
  const t = useTranslations('SmartSending.filter');
  const current = value ?? DEFAULT_ENGAGEMENT_FILTER;

  return (
    <div className="rounded-xl border border-border bg-card/50 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Gauge className="h-4 w-4 text-primary" />
        <p className="text-sm font-medium text-foreground">{t('title')}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {ENGAGEMENT_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => onChange(f)}
            className={cn(
              'rounded-lg border p-3 text-left transition-colors',
              current === f
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/50'
            )}
          >
            <p className="text-sm font-medium text-foreground">{t(`${f}.label`)}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t(`${f}.desc`)}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
