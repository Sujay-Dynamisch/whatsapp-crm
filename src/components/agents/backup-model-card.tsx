'use client';

// Backup AI model (migration 096): if the main model (e.g. a free key)
// fails or runs out, the same reply is sent through this one instead.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, ShieldCheck, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { AI_PROVIDERS, AI_PROVIDER_INFO, type AiProviderId } from '@/lib/ai/providers/registry';

interface State {
  enabled: boolean;
  provider: AiProviderId | null;
  model: string | null;
  base_url: string | null;
  has_key: boolean;
}

const SELECT =
  'h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

export function BackupModelCard() {
  const [state, setState] = useState<State | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [provider, setProvider] = useState<AiProviderId>('openai');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/ai/config/fallback')
      .then(async (r) => ({ ok: r.ok, d: await r.json().catch(() => ({})) }))
      .then(({ ok, d }) => {
        if (!alive) return;
        if (!ok) return setUnavailable(d.error || 'Not available');
        setState(d as State);
        if (d.provider) {
          setProvider(d.provider);
          setModel(d.model ?? '');
          setBaseUrl(d.base_url ?? '');
          setEnabled(d.enabled);
        }
      })
      .catch(() => alive && setUnavailable('Could not load the backup model'));
    return () => {
      alive = false;
    };
  }, []);

  if (unavailable) return null;
  if (!state) return null;
  const info = AI_PROVIDER_INFO[provider];

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/ai/config/fallback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, provider, model: model || info.defaultModel, base_url: baseUrl || null, api_key: apiKey || undefined }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not save');
      setState({ enabled: d.enabled, provider: d.provider, model: d.model, base_url: d.base_url, has_key: true });
      setModel(d.model);
      setApiKey('');
      toast.success('Backup model saved and tested');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({ title: 'Remove the backup model?', description: 'If the main model fails, the AI agent will not reply.', confirmLabel: 'Remove', destructive: true });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch('/api/ai/config/fallback', { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not remove');
      setState({ enabled: false, provider: null, model: null, base_url: null, has_key: false });
      setModel('');
      setBaseUrl('');
      setApiKey('');
      toast.success('Backup model removed');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-4">
      <CardHeader className="border-b">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="size-4" />
            </span>
            <div>
              <CardTitle>Backup model</CardTitle>
              <CardDescription className="text-xs">
                Keep a free key as the main model above. If it fails or runs out, the same reply goes through this backup (e.g. a paid key) — so customers always get an answer and you only pay when the free one can’t.
              </CardDescription>
            </div>
          </div>
          {state.has_key && <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Use the backup model" />}
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 pt-4 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Provider</span>
          <select
            className={SELECT}
            value={provider}
            disabled={busy}
            onChange={(e) => {
              setProvider(e.target.value as AiProviderId);
              setModel('');
            }}
          >
            {AI_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {AI_PROVIDER_INFO[p].label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Model</span>
          <Input value={model} disabled={busy} placeholder={info.defaultModel} onChange={(e) => setModel(e.target.value)} className="h-9" />
        </label>
        {provider === 'openai_compatible' && (
          <label className="space-y-1 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">Endpoint URL</span>
            <Input value={baseUrl} disabled={busy} placeholder="https://api.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} className="h-9" />
          </label>
        )}
        <label className="space-y-1 sm:col-span-2">
          <span className="text-xs font-medium text-muted-foreground">API key</span>
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            disabled={busy}
            placeholder={state.has_key && state.provider === provider ? '•••••••• saved — leave blank to keep' : 'Paste the backup API key'}
            onChange={(e) => setApiKey(e.target.value)}
            className="h-9"
          />
        </label>
      </CardContent>
      <CardFooter className="justify-between gap-2 border-t">
        <p className="text-xs text-muted-foreground">
          {state.has_key ? (state.enabled ? `Active: ${AI_PROVIDER_INFO[state.provider ?? provider]?.label} · ${state.model}` : 'Saved, but switched off') : 'Not set — the AI agent has no backup.'}
        </p>
        <div className="flex gap-2">
          {state.has_key && (
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => void remove()}>
              <Trash2 className="size-3.5" /> Remove
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Test & save
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
