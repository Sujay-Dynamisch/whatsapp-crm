'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Languages, Loader2, Mic } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LANGUAGES } from '@/lib/language/languages';
import {
  DEFAULT_LANGUAGE_SETTINGS,
  type LanguageSettings,
  type TranscriptionProviderChoice,
} from '@/lib/language/settings';
import { SettingsPanelHead } from './settings-panel-head';

const selectClass =
  'h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm text-foreground disabled:opacity-60';

/** Settings → Languages (migration 049). */
export function LanguagePanel() {
  const t = useTranslations('Language.settings');
  const { accountRole, hasFeature } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const translationOn = hasFeature('translation');
  const transcriptionOn = hasFeature('voice_transcription');

  const [settings, setSettings] = useState<LanguageSettings>(DEFAULT_LANGUAGE_SETTINGS);
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/language-settings')
      .then((r) => r.json())
      .then((d) => !cancelled && d?.settings && setSettings(d.settings))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    try {
      const { has_transcription_key: _omit, ...body } = settings;
      void _omit;
      const res = await fetch('/api/language-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          ...(keyEdited ? { transcription_api_key: key.trim() || null } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t('saveFailed', { error: data?.error || `HTTP ${res.status}` }));
        return;
      }
      setSettings(data.settings);
      setKey('');
      setKeyEdited(false);
      toast.success(t('saved'));
    } finally {
      setSaving(false);
    }
  }

  const disabled = loading || saving || !canEdit;
  const set = <K extends keyof LanguageSettings>(k: K, v: LanguageSettings[K]) =>
    setSettings((s) => ({ ...s, [k]: v }));

  return (
    <div className="space-y-4">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Languages className="h-4 w-4 text-primary" />
            {t('translationTitle')}
          </CardTitle>
          <CardDescription>{t('translationDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="lang-agent">{t('agentLanguage')}</Label>
            <select
              id="lang-agent"
              className={selectClass}
              value={settings.agent_language}
              onChange={(e) => set('agent_language', e.target.value)}
              disabled={disabled}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name} — {l.native}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t('agentLanguageDesc')}</p>
          </div>

          {translationOn && (
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('translateInbound')}</p>
                <p className="text-xs text-muted-foreground">{t('translateInboundDesc')}</p>
              </div>
              <Switch
                checked={settings.translate_inbound}
                onCheckedChange={(v) => set('translate_inbound', v)}
                disabled={disabled}
              />
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t('aiKeyNote')}</p>
        </CardContent>
      </Card>

      {transcriptionOn && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Mic className="h-4 w-4 text-primary" />
              {t('voiceTitle')}
            </CardTitle>
            <CardDescription>{t('voiceDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('transcribe')}</p>
                <p className="text-xs text-muted-foreground">{t('transcribeDesc')}</p>
              </div>
              <Switch
                checked={settings.transcribe_voice}
                onCheckedChange={(v) => set('transcribe_voice', v)}
                disabled={disabled}
              />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('summarize')}</p>
                <p className="text-xs text-muted-foreground">{t('summarizeDesc')}</p>
              </div>
              <Switch
                checked={settings.summarize_voice}
                onCheckedChange={(v) => set('summarize_voice', v)}
                disabled={disabled}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="lang-provider">{t('provider')}</Label>
                <select
                  id="lang-provider"
                  className={selectClass}
                  value={settings.transcription_provider}
                  onChange={(e) =>
                    set('transcription_provider', e.target.value as TranscriptionProviderChoice)
                  }
                  disabled={disabled}
                >
                  <option value="auto">{t('providerAuto')}</option>
                  <option value="groq">{t('providerGroq')}</option>
                  <option value="openai">{t('providerOpenai')}</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lang-key">{t('key')}</Label>
                <Input
                  id="lang-key"
                  type="password"
                  autoComplete="off"
                  value={key}
                  placeholder={settings.has_transcription_key ? t('keySet') : 'gsk_… / sk-…'}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setKeyEdited(true);
                  }}
                  disabled={disabled}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('providerHelp')}</p>
          </CardContent>
        </Card>
      )}

      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={save} disabled={disabled} className="w-full sm:w-auto">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      )}
    </div>
  );
}
