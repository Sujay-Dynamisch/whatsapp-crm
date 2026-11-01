'use client';

// Failed messages (feature 'failed_messages', migration 060): the day's
// failed sends with a plain-words reason, and what to do about each —
// resend now, schedule, send a custom text while the 24h window is open,
// or dismiss. Plus website registrations the lead sync skipped, and the
// scheduler / lead-feed status.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  UserPlus,
  X,
  XCircle,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { confirmDialog, promptDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

type Status = 'open' | 'resolved' | 'all';
type DayFilter = 'today' | 'yesterday' | 'week' | 'date';
type Blocked = 'needs_variables' | 'window_closed' | 'opted_out' | 'no_contact' | null;

interface Item {
  key: string;
  source: 'journey' | 'inbox';
  contact_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  conversation_id: string | null;
  journey_name: string | null;
  kind: 'template' | 'text';
  template_name: string | null;
  content_text: string | null;
  error_code: number | null;
  reason: string;
  fix: string;
  retryable: boolean;
  failed_at: string;
  resolved: string | null;
  resolved_at: string | null;
  scheduled_at: string | null;
  window_open: boolean;
  window_closes_at: string | null;
  opted_out: boolean;
  resend_blocked: Blocked;
}

interface Data {
  items: Item[];
  stats: { failed: number; open: number; resolved: number; scheduled: number; window_open: number };
  reasons: { reason: string; code: number | null; count: number }[];
  daily: { date: string; count: number }[];
}

interface Health {
  scheduler: { last_at: string | null; ok: boolean | null };
  lead_feed: { state: 'ok' | 'failing' | 'off'; error: string | null };
  skipped_registrations: number;
}

interface Registration {
  id: string;
  raw_phone: string | null;
  name: string | null;
  email: string | null;
  city: string | null;
  registered_at: string | null;
  created_at: string;
}

interface ActionResult {
  key: string;
  ok: boolean;
  error?: string;
  detail?: string;
}

const DAY = 864e5;

function range(f: DayFilter, date: string): { from: string; to: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (f === 'yesterday') return { from: new Date(start.getTime() - DAY).toISOString(), to: start.toISOString() };
  if (f === 'week') return { from: new Date(start.getTime() - 6 * DAY).toISOString(), to: new Date(start.getTime() + DAY).toISOString() };
  if (f === 'date' && date) {
    const d = new Date(`${date}T00:00:00`);
    return { from: d.toISOString(), to: new Date(d.getTime() + DAY).toISOString() };
  }
  return { from: start.toISOString(), to: new Date(start.getTime() + DAY).toISOString() };
}

/** "Tomorrow 11:00" etc. as an ISO time. */
function preset(kind: 'hour' | 'evening' | 'tomorrow'): string {
  const d = new Date();
  if (kind === 'hour') return new Date(d.getTime() + 3600_000).toISOString();
  if (kind === 'evening') {
    d.setHours(18, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  d.setDate(d.getDate() + 1);
  d.setHours(11, 0, 0, 0);
  return d.toISOString();
}

export default function FailedMessagesPage() {
  const t = useTranslations('FailedMessages');
  const { canSendMessages } = useAuth();
  const [tab, setTab] = useState<'messages' | 'registrations'>('messages');
  const [status, setStatus] = useState<Status>('open');
  const [day, setDay] = useState<DayFilter>('today');
  const [date, setDate] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [regs, setRegs] = useState<Registration[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [textFor, setTextFor] = useState<Item | null>(null);
  const [text, setText] = useState('');
  const [scheduleFor, setScheduleFor] = useState<string[] | null>(null);
  const [customAt, setCustomAt] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = range(day, date);
      const qs = new URLSearchParams({ from, to, status, tz: String(new Date().getTimezoneOffset()) });
      const [res, h, r] = await Promise.all([
        fetch(`/api/failed-messages?${qs}`),
        fetch('/api/health'),
        fetch('/api/failed-messages/registrations'),
      ]);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || t('loadFailed'));
        return;
      }
      setData(json);
      setSelected(new Set());
      if (h.ok) setHealth(await h.json());
      if (r.ok) setRegs((await r.json()).registrations ?? []);
    } finally {
      setLoading(false);
    }
  }, [day, date, status, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const errorText = (r: ActionResult) => (r.error === 'send_failed' ? r.detail || t('err.send_failed') : t(`err.${r.error ?? 'send_failed'}`));

  async function act(keys: string[], action: string, extra: Record<string, unknown> = {}, okMsg?: string) {
    if (!keys.length) return;
    setBusy((b) => new Set([...b, ...keys]));
    try {
      const res = await fetch('/api/failed-messages/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys, action, ...extra }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || t('actionFailed'));
        return;
      }
      const results = (json.results ?? []) as ActionResult[];
      const bad = results.filter((r) => !r.ok);
      if (bad.length === 0) toast.success(okMsg ?? t('done', { count: results.length }));
      else if (bad.length === results.length) toast.error(errorText(bad[0]));
      else toast.warning(t('partly', { ok: results.length - bad.length, failed: bad.length }), { description: errorText(bad[0]) });
      await load();
    } finally {
      setBusy((b) => new Set([...b].filter((k) => !keys.includes(k))));
    }
  }

  async function dismiss(keys: string[]) {
    if (keys.length > 1 && !(await confirmDialog({ title: t('dismissConfirm', { count: keys.length }) }))) return;
    await act(keys, 'dismiss', {}, t('dismissed', { count: keys.length }));
  }

  function openText(item: Item) {
    setTextFor(item);
    setText(item.content_text ?? '');
  }

  async function sendText() {
    if (!textFor || !text.trim()) return;
    const key = textFor.key;
    setTextFor(null);
    await act([key], 'send_text', { text }, t('textSent'));
  }

  async function schedule(at: string) {
    const keys = scheduleFor ?? [];
    setScheduleFor(null);
    await act(keys, 'schedule', { at }, t('scheduled', { when: format(new Date(at), 'MMM d, h:mm a') }));
  }

  async function fixRegistration(r: Registration) {
    const phone = await promptDialog({
      title: t('reg.fixTitle', { name: r.name || '' }),
      label: t('reg.phoneLabel'),
      placeholder: '98XXXXXXXX',
      defaultValue: r.raw_phone ?? '',
      maxLength: 20,
    });
    if (phone === null) return;
    const res = await fetch(`/api/failed-messages/registrations/${r.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', phone }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json?.error || t('actionFailed'));
      return;
    }
    toast.success(json.created ? t('reg.added') : t('reg.restarted'));
    await load();
  }

  async function dismissRegistration(r: Registration) {
    const res = await fetch(`/api/failed-messages/registrations/${r.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss' }),
    });
    if (!res.ok) toast.error(t('actionFailed'));
    await load();
  }

  const items = useMemo(() => data?.items ?? [], [data]);
  const openItems = items.filter((i) => !i.resolved);
  const allSelected = openItems.length > 0 && openItems.every((i) => selected.has(i.key));
  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const maxDaily = Math.max(1, ...(data?.daily ?? []).map((d) => d.count));
  const sel = [...selected];

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

      {/* System health */}
      {health && (
        <div className="grid gap-2 sm:grid-cols-3">
          {[
            {
              label: t('health.scheduler'),
              ok: health.scheduler.ok !== false,
              value:
                health.scheduler.ok === null
                  ? t('health.waiting')
                  : health.scheduler.ok
                    ? t('health.running')
                    : t('health.stopped', { when: formatDistanceToNow(new Date(health.scheduler.last_at!), { addSuffix: true }) }),
            },
            {
              label: t('health.leadFeed'),
              ok: health.lead_feed.state !== 'failing',
              value: health.lead_feed.state === 'off' ? t('health.off') : health.lead_feed.state === 'ok' ? t('health.working') : health.lead_feed.error || t('health.failing'),
            },
            {
              label: t('health.skipped'),
              ok: health.skipped_registrations === 0,
              value: t('health.skippedCount', { count: health.skipped_registrations }),
            },
          ].map((h) => (
            <div key={h.label} className={cn('flex items-start gap-2.5 rounded-xl border px-3 py-2.5', h.ok ? 'border-border bg-card' : 'border-rose-500/40 bg-rose-500/5')}>
              {h.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />}
              <div className="min-w-0">
                <p className="text-[11px] text-muted-foreground">{h.label}</p>
                <p className={cn('truncate text-sm font-medium', h.ok ? 'text-foreground' : 'text-rose-600 dark:text-rose-400')} title={h.value}>
                  {h.value}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Numbers + 14-day trend */}
      <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-border bg-card lg:grid-cols-[1fr_1fr_1fr_1fr_1.4fr]">
        {[
          { label: t('stat.open'), value: data?.stats.open, tone: 'text-rose-500' },
          { label: t('stat.fixed'), value: data?.stats.resolved, tone: 'text-emerald-500' },
          { label: t('stat.scheduled'), value: data?.stats.scheduled, tone: 'text-sky-500' },
          { label: t('stat.windowOpen'), value: data?.stats.window_open, tone: 'text-amber-500' },
        ].map((s, i) => (
          <div key={s.label} className={cn('px-4 py-3', i % 2 === 1 && 'border-l border-border', i > 1 && 'border-t border-border lg:border-t-0', i > 0 && 'lg:border-l')}>
            <p className={cn('text-xl leading-tight font-bold tabular-nums', s.tone)}>{s.value ?? '—'}</p>
            <p className="truncate text-[11px] text-muted-foreground">{s.label}</p>
          </div>
        ))}
        <div className="col-span-2 flex items-center gap-3 border-t border-border px-4 py-3 lg:col-span-1 lg:border-t-0 lg:border-l">
          <p className="shrink-0 text-[11px] text-muted-foreground">{t('last14')}</p>
          <div className="flex h-9 flex-1 items-end gap-[3px]">
            {(data?.daily ?? []).map((d) => (
              <div key={d.date} className="group relative flex h-full flex-1 flex-col justify-end">
                <div
                  className={cn('w-full rounded-sm', d.count === 0 ? 'bg-muted' : 'bg-rose-500/50 group-hover:bg-rose-500/80')}
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

      {/* Tabs */}
      <div className="flex gap-0.5 self-start rounded-full border border-border bg-muted/40 p-0.5 text-xs font-medium">
        {(['messages', 'registrations'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn('rounded-full px-3 py-1', tab === k ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
          >
            {k === 'messages' ? t('tab.messages') : t('tab.registrations', { count: regs?.length ?? 0 })}
          </button>
        ))}
      </div>

      {tab === 'messages' ? (
        <>
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            {[
              { items: ['today', 'yesterday', 'week'] as const, value: day, set: (v: string) => setDay(v as DayFilter), key: 'day' },
              { items: ['open', 'resolved', 'all'] as const, value: status, set: (v: string) => setStatus(v as Status), key: 'status' },
            ].map((g) => (
              <div key={g.key} className="flex gap-0.5 rounded-full border border-border bg-muted/40 p-0.5">
                {g.items.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => g.set(f)}
                    className={cn(
                      'rounded-full px-3 py-1 text-xs font-medium',
                      g.value === f ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t(`${g.key}.${f}`)}
                  </button>
                ))}
              </div>
            ))}
            <Input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setDay(e.target.value ? 'date' : 'today');
              }}
              className="h-8 w-40 rounded-full text-xs"
              aria-label={t('pickDate')}
            />
          </div>

          {/* Top reasons */}
          {(data?.reasons.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {data!.reasons.map((r) => (
                <span key={`${r.code}|${r.reason}`} className="max-w-full truncate rounded-full border border-border bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground" title={r.reason}>
                  <span className="font-semibold text-foreground">{r.count}×</span> {r.code ? `(${r.code}) ` : ''}
                  {r.reason}
                </span>
              ))}
            </div>
          )}

          {/* Bulk actions */}
          {canSendMessages && openItems.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
              <Checkbox
                checked={allSelected}
                onCheckedChange={(v) => setSelected(v ? new Set(openItems.map((i) => i.key)) : new Set())}
                aria-label={t('selectAll')}
              />
              <span className="text-xs text-muted-foreground">{sel.length ? t('selected', { count: sel.length }) : t('selectAll')}</span>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={!sel.length} onClick={() => void act(sel, 'resend')}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t('resend')}
                </Button>
                <Button size="sm" variant="outline" disabled={!sel.length} onClick={() => setScheduleFor(sel)}>
                  <CalendarClock className="h-3.5 w-3.5" />
                  {t('schedule')}
                </Button>
                <Button size="sm" variant="ghost" disabled={!sel.length} onClick={() => void dismiss(sel)}>
                  <X className="h-3.5 w-3.5" />
                  {t('dismiss')}
                </Button>
              </div>
            </div>
          )}

          {/* List */}
          {data === null ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-10 text-center">
              <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" />
              <p className="mt-3 font-medium text-foreground">{status === 'open' ? t('emptyOpen') : t('empty')}</p>
            </div>
          ) : (
            <ul className={cn('space-y-2 transition-opacity', loading && 'opacity-60')}>
              {items.map((i) => {
                const name = i.contact_name || i.contact_phone || t('unknown');
                const isBusy = busy.has(i.key);
                return (
                  <li key={i.key} className={cn('rounded-xl border bg-card p-3', i.resolved ? 'border-border opacity-80' : 'border-rose-500/30')}>
                    <div className="flex items-start gap-3">
                      {canSendMessages && !i.resolved && (
                        <Checkbox className="mt-1" checked={selected.has(i.key)} onCheckedChange={() => toggle(i.key)} aria-label={name} />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-semibold text-foreground">{name}</span>
                          {i.contact_phone && i.contact_name && <span className="text-xs text-muted-foreground tabular-nums">{i.contact_phone}</span>}
                          <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                            {i.journey_name ? t('fromJourney', { name: i.journey_name }) : t('fromInbox')}
                          </span>
                          <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-foreground">
                            {i.kind === 'template' ? i.template_name : t('textMessage')}
                          </span>
                          <span className="text-[11px] text-muted-foreground">{format(new Date(i.failed_at), 'MMM d, h:mm a')}</span>
                        </div>
                        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-rose-600 dark:text-rose-400">
                          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>
                            {i.error_code ? <span className="font-mono">({i.error_code}) </span> : null}
                            {i.reason}
                          </span>
                        </p>
                        {i.content_text && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">“{i.content_text}”</p>}
                        <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                          {i.opted_out ? (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{t('optedOut')}</span>
                          ) : i.window_open ? (
                            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-600 dark:text-emerald-400">
                              {t('windowOpen', { time: format(new Date(i.window_closes_at!), 'h:mm a') })}
                            </span>
                          ) : (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{t('windowClosed')}</span>
                          )}
                          {i.scheduled_at && (
                            <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-sky-600 dark:text-sky-400">
                              <Clock className="mr-1 inline h-3 w-3" />
                              {t('scheduledFor', { when: format(new Date(i.scheduled_at), 'MMM d, h:mm a') })}
                            </span>
                          )}
                          {i.resolved && (
                            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-600 dark:text-emerald-400">
                              {t(`resolved.${i.resolved}`)}
                              {i.resolved_at ? ` · ${format(new Date(i.resolved_at), 'MMM d, h:mm a')}` : ''}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {!i.resolved && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {i.conversation_id && (
                          <Link href={`/inbox?c=${i.conversation_id}`} className={buttonVariants({ size: 'sm', variant: 'ghost' })}>
                            <MessageSquare className="h-3.5 w-3.5" />
                            {t('openChat')}
                          </Link>
                        )}
                        {canSendMessages && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={isBusy || Boolean(i.resend_blocked)}
                              title={i.resend_blocked ? t(`err.${i.resend_blocked}`) : undefined}
                              onClick={() => void act([i.key], 'resend', {}, t('resent'))}
                            >
                              {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                              {t('resend')}
                            </Button>
                            {i.scheduled_at ? (
                              <Button size="sm" variant="outline" disabled={isBusy} onClick={() => void act([i.key], 'cancel_schedule', {}, t('unscheduled'))}>
                                <CalendarClock className="h-3.5 w-3.5" />
                                {t('cancelSchedule')}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isBusy || i.opted_out || i.resend_blocked === 'needs_variables'}
                                onClick={() => setScheduleFor([i.key])}
                              >
                                <CalendarClock className="h-3.5 w-3.5" />
                                {t('schedule')}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={isBusy || !i.window_open || i.opted_out}
                              title={!i.window_open ? t('err.window_closed') : undefined}
                              onClick={() => openText(i)}
                            >
                              <Send className="h-3.5 w-3.5" />
                              {t('sendText')}
                            </Button>
                            <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => void dismiss([i.key])}>
                              <X className="h-3.5 w-3.5" />
                              {t('dismiss')}
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : (
        /* Skipped registrations */
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{t('reg.hint')}</p>
          {regs === null ? (
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          ) : regs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-10 text-center">
              <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" />
              <p className="mt-3 font-medium text-foreground">{t('reg.empty')}</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {regs.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-card p-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-foreground">{r.name || t('unknown')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('reg.number')}: <span className="font-mono text-rose-500">{r.raw_phone || t('reg.noNumber')}</span>
                      {r.email ? ` · ${r.email}` : ''}
                      {r.city ? ` · ${r.city}` : ''}
                      {' · '}
                      {format(new Date(r.registered_at ?? r.created_at), 'MMM d, h:mm a')}
                    </p>
                  </div>
                  {canSendMessages && (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => void fixRegistration(r)}>
                        <UserPlus className="h-3.5 w-3.5" />
                        {t('reg.fix')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void dismissRegistration(r)}>
                        <X className="h-3.5 w-3.5" />
                        {t('dismiss')}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Send a custom text (24h window open) */}
      <Dialog open={textFor !== null} onOpenChange={(o) => !o && setTextFor(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('textTitle', { name: textFor?.contact_name || textFor?.contact_phone || '' })}</DialogTitle>
            <DialogDescription>
              {t('textDesc', { time: textFor?.window_closes_at ? format(new Date(textFor.window_closes_at), 'h:mm a') : '' })}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} maxLength={4096} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTextFor(null)}>
              {t('cancel')}
            </Button>
            <Button disabled={!text.trim()} onClick={() => void sendText()}>
              <Send className="h-3.5 w-3.5" />
              {t('send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Schedule a resend */}
      <Dialog open={scheduleFor !== null} onOpenChange={(o) => !o && setScheduleFor(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('scheduleTitle', { count: scheduleFor?.length ?? 0 })}</DialogTitle>
            <DialogDescription>{t('scheduleDesc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {(['hour', 'evening', 'tomorrow'] as const).map((p) => (
              <Button key={p} variant="outline" className="justify-start" onClick={() => void schedule(preset(p))}>
                <Clock className="h-3.5 w-3.5" />
                {t(`preset.${p}`)}
                <span className="ml-auto text-xs text-muted-foreground">{format(new Date(preset(p)), 'EEE h:mm a')}</span>
              </Button>
            ))}
            <div className="flex gap-2">
              <Input type="datetime-local" value={customAt} onChange={(e) => setCustomAt(e.target.value)} aria-label={t('preset.custom')} />
              <Button disabled={!customAt} onClick={() => void schedule(new Date(customAt).toISOString())}>
                {t('schedule')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
