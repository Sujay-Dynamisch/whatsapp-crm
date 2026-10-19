'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';

import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DEFAULT_DELIVERY_SETTINGS,
  type DeliverySettings,
} from '@/lib/smart-sending/settings';
import { SettingsPanelHead } from './settings-panel-head';

interface QualityState {
  rating: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  tier: string | null;
  action: 'allow' | 'slow' | 'block';
  checkedAt: string | null;
  lastEvent: string | null;
  refreshError: string | null;
}

const RATING_CLASS: Record<QualityState['rating'], string> = {
  GREEN: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400',
  YELLOW: 'bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400',
  RED: 'bg-red-500/10 text-red-600 border-red-500/30 dark:text-red-400',
  UNKNOWN: 'bg-muted text-muted-foreground border-border',
};

/** Settings → Smart sending (migration 048). */
export function SmartSendingPanel() {
  const t = useTranslations('SmartSending.settings');
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [settings, setSettings] = useState<DeliverySettings>(DEFAULT_DELIVERY_SETTINGS);
  const [quality, setQuality] = useState<QualityState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadQuality = useCallback(async (refresh: boolean) => {
    const res = await fetch(`/api/whatsapp/quality${refresh ? '?refresh=1' : ''}`);
    const data = await res.json().catch(() => null);
    if (res.ok && data) setQuality(data);
    return data as QualityState | null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s] = await Promise.all([
          fetch('/api/delivery-settings').then((r) => r.json()),
          loadQuality(false),
        ]);
        if (!cancelled && s?.settings) setSettings(s.settings);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadQuality]);

  async function refresh() {
    setRefreshing(true);
    try {
      const q = await loadQuality(true);
      if (q?.refreshError) toast.error(t('refreshFailed', { error: q.refreshError }));
    } finally {
      setRefreshing(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/delivery-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t('saveFailed', { error: data?.error || `HTTP ${res.status}` }));
        return;
      }
      setSettings(data.settings);
      toast.success(t('saved'));
    } finally {
      setSaving(false);
    }
  }

  const disabled = loading || saving || !canEdit;
  const num = (key: keyof DeliverySettings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setSettings((s) => ({ ...s, [key]: Number(e.target.value) }));

  return (
    <div className="space-y-4">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {/* Number quality */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" />
            {t('qualityTitle')}
          </CardTitle>
          <CardDescription>{t('qualityDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!quality ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={cn(
                  'rounded-full border px-3 py-1 text-sm font-semibold',
                  RATING_CLASS[quality.rating]
                )}
              >
                {t(`rating.${quality.rating}`)}
              </span>
              {quality.tier && (
                <span className="text-sm text-muted-foreground">
                  {t('tier', { tier: quality.tier })}
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {quality.checkedAt
                  ? t('checked', {
                      when: formatDistanceToNow(new Date(quality.checkedAt), { addSuffix: true }),
                    })
                  : t('neverChecked')}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={refresh}
                disabled={refreshing}
                className="sm:ml-auto"
              >
                {refreshing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {t('refresh')}
              </Button>
            </div>
          )}
          {quality && (
            <p className="text-xs text-muted-foreground">{t(`action.${quality.action}`)}</p>
          )}
        </CardContent>
      </Card>

      {/* Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('rulesTitle')}</CardTitle>
          <CardDescription>{t('rulesDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t('autoRetry')}</p>
              <p className="text-xs text-muted-foreground">{t('autoRetryDesc')}</p>
            </div>
            <Switch
              checked={settings.auto_retry_limited}
              onCheckedChange={(v) => setSettings((s) => ({ ...s, auto_retry_limited: v }))}
              disabled={disabled}
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t('qualityGuard')}</p>
              <p className="text-xs text-muted-foreground">{t('qualityGuardDesc')}</p>
            </div>
            <Switch
              checked={settings.quality_guard}
              onCheckedChange={(v) => setSettings((s) => ({ ...s, quality_guard: v }))}
              disabled={disabled}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ss-retry">{t('retryDelay')}</Label>
              <Input id="ss-retry" type="number" min={12} max={72} value={settings.retry_delay_hours} onChange={num('retry_delay_hours')} disabled={disabled} />
              <p className="text-xs text-muted-foreground">{t('retryDelayDesc')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ss-rest-days">{t('restDays')}</Label>
              <Input id="ss-rest-days" type="number" min={1} max={60} value={settings.rest_days} onChange={num('rest_days')} disabled={disabled} />
              <p className="text-xs text-muted-foreground">{t('restDaysDesc')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ss-rest-unread">{t('restUnread')}</Label>
              <Input id="ss-rest-unread" type="number" min={2} max={20} value={settings.rest_after_unread} onChange={num('rest_after_unread')} disabled={disabled} />
              <p className="text-xs text-muted-foreground">{t('restUnreadDesc')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ss-yellow">{t('yellowPass')}</Label>
              <Input id="ss-yellow" type="number" min={10} max={1000} value={settings.yellow_pass_size} onChange={num('yellow_pass_size')} disabled={disabled} />
              <p className="text-xs text-muted-foreground">{t('yellowPassDesc')}</p>
            </div>
          </div>

          {canEdit && (
            <div className="flex justify-end">
              <Button onClick={save} disabled={disabled} className="w-full sm:w-auto">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('save')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
