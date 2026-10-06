'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Clock, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DEFAULT_KEEPALIVE_SETTINGS,
  type KeepaliveSettings,
} from '@/lib/conversations/window-keepalive-settings';

/**
 * Settings for the 24h-window keep-alive (migration 044): one check-in
 * message sent shortly before WhatsApp's customer-service window
 * closes, so a reply re-opens it.
 */
export function WindowKeepaliveCard() {
  const t = useTranslations('WindowKeepalive');
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [settings, setSettings] = useState<KeepaliveSettings>(DEFAULT_KEEPALIVE_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/conversations/window-keepalive');
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && data.settings) setSettings(data.settings);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/conversations/window-keepalive', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t('toastFailed', { error: data?.error || `HTTP ${res.status}` }));
        return;
      }
      setSettings(data.settings);
      toast.success(t('toastSaved'));
    } finally {
      setSaving(false);
    }
  }

  const disabled = loading || saving || !canEdit;
  const sendAtHour = Math.round((24 * 60 - settings.lead_minutes) / 6) / 10;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4 text-primary" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
          <div>
            <p className="text-sm font-medium text-foreground">{t('enable')}</p>
            <p className="text-xs text-muted-foreground">{t('enableDesc', { hour: sendAtHour })}</p>
          </div>
          <Switch
            checked={settings.enabled}
            onCheckedChange={(enabled) => setSettings((s) => ({ ...s, enabled }))}
            disabled={disabled}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="keepalive-text">{t('message')}</Label>
          <Textarea
            id="keepalive-text"
            value={settings.message_text}
            onChange={(e) => setSettings((s) => ({ ...s, message_text: e.target.value }))}
            rows={3}
            maxLength={1000}
            disabled={disabled}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="keepalive-lead">{t('lead')}</Label>
            <Input
              id="keepalive-lead"
              type="number"
              min={15}
              max={240}
              value={settings.lead_minutes}
              onChange={(e) => setSettings((s) => ({ ...s, lead_minutes: Number(e.target.value) }))}
              disabled={disabled}
            />
            <p className="text-xs text-muted-foreground">{t('leadDesc')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="keepalive-quiet">{t('quiet')}</Label>
            <Input
              id="keepalive-quiet"
              type="number"
              min={0}
              max={240}
              value={settings.quiet_minutes}
              onChange={(e) => setSettings((s) => ({ ...s, quiet_minutes: Number(e.target.value) }))}
              disabled={disabled}
            />
            <p className="text-xs text-muted-foreground">{t('quietDesc')}</p>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">{t('rules')}</p>

        {canEdit && (
          <div className="flex justify-end">
            <Button onClick={save} disabled={disabled}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
