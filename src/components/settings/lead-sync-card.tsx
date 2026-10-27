'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { confirmDialog } from '@/components/ui/confirm-dialog';

interface LeadSyncSource {
  source_url: string;
  enabled: boolean;
  last_run_at: string | null;
  last_report: { fetched?: number; created?: number; existing?: number; error?: string } | null;
}

/**
 * On/off switch for the account's external registration sync
 * (lead_sync_sources, run by the journeyTick function). Renders nothing
 * for accounts without a configured source.
 */
export function LeadSyncCard() {
  const t = useTranslations('Settings.leadSync');
  const supabase = createClient();
  const { accountId, canEditSettings } = useAuth();
  const [source, setSource] = useState<LeadSyncSource | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    const { data } = await supabase
      .from('lead_sync_sources')
      .select('source_url, enabled, last_run_at, last_report')
      .eq('account_id', accountId)
      .maybeSingle();
    setSource((data as LeadSyncSource | null) ?? null);
  }, [supabase, accountId]);

  // setSource runs after the Supabase await, not synchronously.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (!source) return null;

  async function toggle(enabled: boolean) {
    if (enabled && !(await confirmDialog({ title: t('enableConfirm'), description: t('enableConfirmDesc') }))) return;
    setSaving(true);
    const { error } = await supabase
      .from('lead_sync_sources')
      .update({ enabled, updated_at: new Date().toISOString() })
      .eq('account_id', accountId!);
    setSaving(false);
    if (error) {
      toast.error(t('saveFailed'));
      return;
    }
    toast.success(enabled ? t('enabled') : t('disabled'));
    await load();
  }

  const r = source.last_report;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {source.enabled ? t('statusOn') : t('statusOff')}
            </p>
            <p className="truncate text-xs text-muted-foreground">{source.source_url}</p>
          </div>
          <div className="flex items-center gap-2">
            {saving && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            <Switch
              checked={source.enabled}
              onCheckedChange={toggle}
              disabled={saving || !canEditSettings}
            />
          </div>
        </div>
        {source.last_run_at && (
          <p className="text-xs text-muted-foreground">
            {t('lastRun', { time: new Date(source.last_run_at).toLocaleString() })}{' '}
            {r?.error
              ? t('lastError', { error: r.error })
              : t('lastReport', { fetched: r?.fetched ?? 0, created: r?.created ?? 0, existing: r?.existing ?? 0 })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
