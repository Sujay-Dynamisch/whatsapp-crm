'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  CheckCircle2,
  Clock,
  Copy,
  Loader2,
  MessageSquare,
  PhoneCall,
  PhoneMissed,
  PhoneOutgoing,
  RefreshCw,
  RotateCcw,
  Search,
  StickyNote,
  X,
} from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { promptDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';

type Status = 'new' | 'called' | 'no_answer' | 'done';
type StatusFilter = 'open' | Status | 'all';
type DayFilter = 'today' | 'yesterday' | 'week' | 'all';

interface CallbackRequest {
  id: string;
  contact_id: string;
  conversation_id: string | null;
  status: Status;
  source: string | null;
  note: string | null;
  requested_at: string;
  handled_at: string | null;
  contact_name: string | null;
  contact_phone: string | null;
}

interface Data {
  requests: CallbackRequest[];
  stats: { open: number; today: number; handled_today: number };
  daily: { date: string; count: number }[];
}

const STATUS_FILTERS: StatusFilter[] = ['open', 'new', 'called', 'no_answer', 'done', 'all'];
const DAY_FILTERS: DayFilter[] = ['today', 'yesterday', 'week', 'all'];
/** A new request older than this is highlighted as overdue. */
const OVERDUE_MS = 2 * 3600_000;

const STATUS_STYLE: Record<Status, string> = {
  new: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  called: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  no_answer: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400',
  done: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
};

function dayRange(f: DayFilter): { from?: string; to?: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (f === 'today') return { from: start.toISOString() };
  if (f === 'yesterday') {
    const y = new Date(start.getTime() - 864e5);
    return { from: y.toISOString(), to: start.toISOString() };
  }
  if (f === 'week') return { from: new Date(start.getTime() - 6 * 864e5).toISOString() };
  return {};
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
}

export default function CallbacksPage() {
  const t = useTranslations('Callbacks');
  const { canSendMessages } = useAuth();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [dayFilter, setDayFilter] = useState<DayFilter>('all');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ tz: String(new Date().getTimezoneOffset()) });
      if (statusFilter !== 'all') qs.set('status', statusFilter);
      const { from, to } = dayRange(dayFilter);
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      if (search) qs.set('q', search);
      const res = await fetch(`/api/callbacks?${qs}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || t('loadFailed'));
        return;
      }
      setData(json);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, dayFilter, search, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // New requests / updates from teammates show up without a refresh.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel('callbacks-page')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'callback_requests' }, () => void load())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  async function update(r: CallbackRequest, patch: { status?: Status; note?: string }, okMsg: string) {
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/callbacks/${r.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || t('updateFailed'));
        return;
      }
      toast.success(okMsg);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function editNote(r: CallbackRequest) {
    const note = await promptDialog({
      title: t('noteTitle', { name: r.contact_name || r.contact_phone || '' }),
      placeholder: t('notePlaceholder'),
      defaultValue: r.note ?? '',
      maxLength: 500,
    });
    if (note === null) return;
    await update(r, { note }, t('noteSaved'));
  }

  async function copy(phone: string) {
    try {
      await navigator.clipboard.writeText(phone);
      toast.success(t('copied'));
    } catch {
      toast.error(phone);
    }
  }

  const maxDaily = useMemo(() => Math.max(1, ...(data?.daily ?? []).map((d) => d.count)), [data]);
  const now = Date.now();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          {t('refresh')}
        </Button>
      </div>

      {/* Headline numbers + 14-day trend, one strip */}
      <div className="grid grid-cols-3 overflow-hidden rounded-2xl border border-border bg-card lg:grid-cols-[1fr_1fr_1fr_1.4fr]">
        {[
          { label: t('statWaiting'), value: data?.stats.open, icon: Clock, tone: 'text-amber-500 bg-amber-500/10' },
          { label: t('statToday'), value: data?.stats.today, icon: PhoneCall, tone: 'text-primary bg-primary/10' },
          { label: t('statHandledToday'), value: data?.stats.handled_today, icon: CheckCircle2, tone: 'text-emerald-500 bg-emerald-500/10' },
        ].map((s, i) => (
          <div key={s.label} className={cn('flex items-center gap-3 px-4 py-3', i > 0 && 'border-l border-border')}>
            <span className={cn('hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:flex', s.tone)}>
              <s.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-xl leading-tight font-bold tabular-nums text-foreground">{s.value ?? '—'}</p>
              <p className="truncate text-[11px] text-muted-foreground">{s.label}</p>
            </div>
          </div>
        ))}
        <div className="col-span-3 flex items-center gap-3 border-t border-border px-4 py-3 lg:col-span-1 lg:border-t-0 lg:border-l">
          <div className="shrink-0">
            <p className="text-xl leading-tight font-bold tabular-nums text-foreground">
              {(data?.daily ?? []).reduce((n, d) => n + d.count, 0)}
            </p>
            <p className="text-[11px] text-muted-foreground">{t('last14')}</p>
          </div>
          <div className="flex h-9 flex-1 items-end gap-[3px]">
            {(data?.daily ?? []).map((d, i, arr) => (
              <div key={d.date} className="group relative flex h-full flex-1 flex-col justify-end">
                <div
                  className={cn(
                    'w-full rounded-sm transition-colors',
                    d.count === 0 ? 'bg-muted' : i === arr.length - 1 ? 'bg-primary' : 'bg-primary/40 group-hover:bg-primary/70'
                  )}
                  style={{ height: `${Math.max(10, (d.count / maxDaily) * 100)}%` }}
                />
                <span className="pointer-events-none absolute -top-7 left-1/2 z-10 hidden -translate-x-1/2 rounded bg-popover px-1.5 py-0.5 text-[10px] whitespace-nowrap text-popover-foreground shadow group-hover:block">
                  {format(new Date(`${d.date}T00:00:00`), 'MMM d')}: {d.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Toolbar: search · status · day */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="h-8 rounded-full pr-8 pl-8 text-sm"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('clearSearch')}
              className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {[
          { items: STATUS_FILTERS, value: statusFilter, set: setStatusFilter, key: 'filter' },
          { items: DAY_FILTERS, value: dayFilter, set: setDayFilter, key: 'day' },
        ].map((g, gi) => (
          <div
            key={g.key}
            className={cn('flex max-w-full gap-0.5 overflow-x-auto rounded-full border border-border bg-muted/40 p-0.5', gi === 1 && 'lg:ml-auto')}
          >
            {g.items.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => (g.set as (v: string) => void)(f)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  g.value === f ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {loading && g.value === f && <Loader2 className="h-3 w-3 animate-spin" />}
                {t(`${g.key}.${f}`)}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* List */}
      {data === null ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : loading && data.requests.length === 0 ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : data.requests.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center">
          <PhoneCall className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 font-medium text-foreground">{search ? t('noResults') : t('emptyTitle')}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t('emptyHint')}</p>
        </div>
      ) : (
        <div className="relative">
        {loading && (
          <div className="absolute inset-x-0 top-2 z-10 flex justify-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-popover px-3 py-1 text-xs text-muted-foreground shadow-md">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              {t('loading')}
            </span>
          </div>
        )}
        <ul className={cn('grid gap-3 transition-opacity xl:grid-cols-2', loading && 'pointer-events-none opacity-50')}>
          {data.requests.map((r) => {
            const name = r.contact_name || r.contact_phone || t('unknown');
            const overdue = r.status === 'new' && now - Date.parse(r.requested_at) > OVERDUE_MS;
            const busy = busyId === r.id;
            return (
              <li
                key={r.id}
                className={cn(
                  'rounded-2xl border bg-card p-4 transition-shadow hover:shadow-md',
                  overdue ? 'border-rose-500/50' : 'border-border',
                  busy && 'opacity-60'
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                    {initials(name) || <PhoneCall className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-semibold text-foreground">{name}</p>
                      <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', STATUS_STYLE[r.status])}>
                        {t(`status.${r.status}`)}
                      </span>
                    </div>
                    {r.contact_phone && (
                      <div className="mt-1 flex items-center gap-1.5">
                        <a href={`tel:${r.contact_phone}`} className="text-lg font-semibold tracking-wide text-foreground tabular-nums hover:text-primary">
                          {r.contact_phone}
                        </a>
                        <button
                          type="button"
                          onClick={() => void copy(r.contact_phone!)}
                          aria-label={t('copy')}
                          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                    <p className={cn('mt-1 text-xs', overdue ? 'font-medium text-rose-500' : 'text-muted-foreground')}>
                      {overdue && '⚠ '}
                      {t('requested', {
                        when: formatDistanceToNow(new Date(r.requested_at), { addSuffix: true }),
                        time: format(new Date(r.requested_at), 'MMM d, h:mm a'),
                      })}
                    </p>
                    {r.source && (
                      <p className="mt-2 inline-flex max-w-full items-center gap-1 rounded-lg bg-muted px-2 py-1 text-xs text-muted-foreground">
                        <span className="shrink-0">{t('said')}</span>
                        <span className="truncate font-medium text-foreground">“{r.source}”</span>
                      </p>
                    )}
                    {r.note && (
                      <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                        <StickyNote className="mt-0.5 h-3 w-3 shrink-0" />
                        <span className="break-words">{r.note}</span>
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {r.contact_phone && (
                    <a href={`tel:${r.contact_phone}`} className={buttonVariants({ size: 'sm' })}>
                      <PhoneOutgoing className="h-3.5 w-3.5" />
                      {t('call')}
                    </a>
                  )}
                  {r.conversation_id && (
                    <Link href={`/inbox?c=${r.conversation_id}`} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                      <MessageSquare className="h-3.5 w-3.5" />
                      {t('openChat')}
                    </Link>
                  )}
                  {canSendMessages && (
                    <>
                      {r.status !== 'done' ? (
                        <>
                          {r.status !== 'called' && (
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => void update(r, { status: 'called' }, t('markedCalled'))}>
                              <PhoneCall className="h-3.5 w-3.5" />
                              {t('markCalled')}
                            </Button>
                          )}
                          {r.status !== 'no_answer' && (
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => void update(r, { status: 'no_answer' }, t('markedNoAnswer'))}>
                              <PhoneMissed className="h-3.5 w-3.5" />
                              {t('markNoAnswer')}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            className="border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
                            onClick={() => void update(r, { status: 'done' }, t('markedDone'))}
                          >
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                            {t('markDone')}
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void update(r, { status: 'new' }, t('reopened'))}>
                          <RotateCcw className="h-3.5 w-3.5" />
                          {t('reopen')}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void editNote(r)}>
                        <StickyNote className="h-3.5 w-3.5" />
                        {r.note ? t('editNote') : t('addNote')}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        </div>
      )}
    </div>
  );
}
