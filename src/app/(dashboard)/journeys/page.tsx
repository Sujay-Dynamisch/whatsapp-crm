'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { Loader2, Plus, Route, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface JourneySummary {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'paused';
  trigger_type: string;
  updated_at: string;
  stats: { in_progress: number; completed: number; failed: number; total: number };
}

const STATUS_CLASS: Record<JourneySummary['status'], string> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  paused: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  draft: 'border-border bg-muted text-muted-foreground',
};

export default function JourneysPage() {
  const t = useTranslations('Journeys');
  const router = useRouter();
  const { canSendMessages, canEditSettings } = useAuth();
  const [journeys, setJourneys] = useState<JourneySummary[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  async function load() {
    const res = await fetch('/api/journeys');
    const data = await res.json().catch(() => ({}));
    if (res.ok) setJourneys(data.journeys);
    else toast.error(data?.error || `HTTP ${res.status}`);
  }

  useEffect(() => {
    load();
  }, []);

  async function create() {
    setCreating(true);
    try {
      const res = await fetch('/api/journeys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || `HTTP ${res.status}`);
        return;
      }
      router.push(`/journeys/${data.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function remove(j: JourneySummary) {
    if (!window.confirm(t('list.deleteConfirm', { name: j.name }))) return;
    const res = await fetch(`/api/journeys/${j.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error(t('list.deleteFailed'));
      return;
    }
    setJourneys((list) => list?.filter((x) => x.id !== j.id) ?? null);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('list.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('list.subtitle')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} disabled={!canSendMessages} className="w-full sm:w-auto">
          <Plus className="h-4 w-4" />
          {t('list.new')}
        </Button>
      </div>

      {journeys === null ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : journeys.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <Route className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 font-medium text-foreground">{t('list.emptyTitle')}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t('list.emptyHint')}</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {journeys.map((j) => (
            <div key={j.id} className="flex flex-col rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/journeys/${j.id}`} className="min-w-0 font-semibold text-foreground hover:text-primary">
                  <span className="line-clamp-2 break-words">{j.name}</span>
                </Link>
                <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium', STATUS_CLASS[j.status])}>
                  {t(`status.${j.status}`)}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t(`trigger.${j.trigger_type}`)}</p>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-lg font-bold text-foreground">{j.stats.in_progress}</p>
                  <p className="text-[11px] text-muted-foreground">{t('list.inProgress')}</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-foreground">{j.stats.completed}</p>
                  <p className="text-[11px] text-muted-foreground">{t('list.completed')}</p>
                </div>
                <div>
                  <p className={cn('text-lg font-bold', j.stats.failed ? 'text-destructive' : 'text-foreground')}>
                    {j.stats.failed}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{t('list.failed')}</p>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
                <span className="text-xs text-muted-foreground">
                  {t('list.updated', { when: formatDistanceToNow(new Date(j.updated_at), { addSuffix: true }) })}
                </span>
                <div className="flex gap-1">
                  {canEditSettings && (
                    <Button size="icon" variant="ghost" onClick={() => remove(j)} aria-label={t('list.delete')}>
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => router.push(`/journeys/${j.id}`)}>
                    {t('list.open')}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('list.new')}</DialogTitle>
            <DialogDescription>{t('list.newDesc')}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('list.namePlaceholder')}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t('editor.cancel')}
            </Button>
            <Button onClick={create} disabled={!name.trim() || creating}>
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('list.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
