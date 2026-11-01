'use client';
import { confirmDialog } from '@/components/ui/confirm-dialog';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { ArrowUpRight, Loader2, MoreHorizontal, Plus, Route, Search, SearchX, Trash2, X } from 'lucide-react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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

type StatusFilter = 'all' | JourneySummary['status'];
const FILTERS: StatusFilter[] = ['all', 'active', 'paused', 'draft'];
const STATUS_DOT: Record<JourneySummary['status'], string> = {
  active: 'bg-emerald-500',
  paused: 'bg-amber-500',
  draft: 'bg-muted-foreground/50',
};

export default function JourneysPage() {
  const t = useTranslations('Journeys');
  const router = useRouter();
  const { canSendMessages, canEditSettings } = useAuth();
  const [journeys, setJourneys] = useState<JourneySummary[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: 0, active: 0, paused: 0, draft: 0 };
    for (const j of journeys ?? []) {
      c.all++;
      c[j.status]++;
    }
    return c;
  }, [journeys]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (journeys ?? []).filter(
      (j) =>
        (filter === 'all' || j.status === filter) &&
        (!q || j.name.toLowerCase().includes(q) || (j.description ?? '').toLowerCase().includes(q))
    );
  }, [journeys, query, filter]);

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
    if (!(await confirmDialog({ title: t('list.deleteConfirm', { name: j.name }), action: 'delete' }))) return;
    setDeletingId(j.id);
    try {
      const res = await fetch(`/api/journeys/${j.id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t('list.deleteFailed'));
        return;
      }
      setJourneys((list) => list?.filter((x) => x.id !== j.id) ?? null);
      toast.success(t('list.deleted', { name: j.name }));
    } finally {
      setDeletingId(null);
    }
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
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('list.searchPlaceholder')}
                className="h-9 rounded-full pr-8 pl-9"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label={t('list.clearSearch')}
                  className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="flex gap-1 overflow-x-auto rounded-full border border-border bg-muted/40 p-1">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                    filter === f ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {f !== 'all' && <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[f])} />}
                  {f === 'all' ? t('list.all') : t(`status.${f}`)}
                  <span className="tabular-nums text-muted-foreground">{counts[f]}</span>
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-10 text-center">
              <SearchX className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 font-medium text-foreground">{t('list.noResults')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t('list.noResultsHint')}</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map((j) => (
                <div
                  key={j.id}
                  className={cn(
                    'group relative flex flex-col rounded-2xl border border-border bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg',
                    deletingId === j.id && 'pointer-events-none opacity-50'
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Route className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      {/* The ::after overlay makes the whole card clickable. */}
                      <Link
                        href={`/journeys/${j.id}`}
                        className="font-semibold text-foreground after:absolute after:inset-0 after:rounded-2xl group-hover:text-primary"
                      >
                        <span className="line-clamp-2 break-words">{j.name}</span>
                      </Link>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{t(`trigger.${j.trigger_type}`)}</p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button size="icon-sm" variant="ghost" className="relative z-10 -mt-1 -mr-2" aria-label={t('list.actions')}>
                            {deletingId === j.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => router.push(`/journeys/${j.id}`)}>
                          <ArrowUpRight className="h-4 w-4" />
                          {t('list.open')}
                        </DropdownMenuItem>
                        {canEditSettings && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onClick={() => remove(j)}>
                              <Trash2 className="h-4 w-4" />
                              {t('list.delete')}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {j.description && <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{j.description}</p>}

                  <div className="mt-4 grid grid-cols-3 divide-x divide-border rounded-xl bg-muted/40 py-2.5 text-center">
                    <div>
                      <p className="text-lg font-bold tabular-nums text-foreground">{j.stats.in_progress}</p>
                      <p className="text-[11px] text-muted-foreground">{t('list.inProgress')}</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold tabular-nums text-foreground">{j.stats.completed}</p>
                      <p className="text-[11px] text-muted-foreground">{t('list.completed')}</p>
                    </div>
                    <div>
                      <p className={cn('text-lg font-bold tabular-nums', j.stats.failed ? 'text-destructive' : 'text-foreground')}>
                        {j.stats.failed}
                      </p>
                      <p className="text-[11px] text-muted-foreground">{t('list.failed')}</p>
                    </div>
                  </div>

                  <div className="mt-4 flex items-center justify-between gap-2">
                    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium', STATUS_CLASS[j.status])}>
                      <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[j.status], j.status === 'active' && 'animate-pulse')} />
                      {t(`status.${j.status}`)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t('list.updated', { when: formatDistanceToNow(new Date(j.updated_at), { addSuffix: true }) })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
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
