'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import {
  ChevronRight,
  Download,
  Loader2,
  MessageSquare,
  MousePointerClick,
  PhoneOutgoing,
  Radio,
  Search,
  Trophy,
  Users,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { startOfLocalDay } from '@/lib/dashboard/date-utils';
import { cn } from '@/lib/utils';

const RANGES = ['today', 7, 30, 90] as const;
type RangeOption = (typeof RANGES)[number];

interface Summary {
  totals: {
    clicks: number;
    unique_contacts: number;
    from_broadcasts: number;
    from_inbox: number;
    from_bot: number;
  };
  by_button: {
    button: string;
    template_name: string | null;
    button_kind: string;
    clicks: number;
    unique_contacts: number;
    last_clicked_at: string;
  }[];
  by_broadcast: {
    broadcast_id: string;
    name: string;
    template_name: string;
    sent_count: number;
    clicks: number;
    unique_clickers: number;
  }[];
}

interface RecentClick {
  id: string;
  clicked_at: string;
  button_text: string | null;
  button_payload: string | null;
  button_kind: string;
  card_index: number | null;
  source: 'broadcast' | 'inbox' | 'bot' | 'unknown';
  template_name: string | null;
  conversation_id: string | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
  broadcast: { id: string; name: string } | null;
}

/** Rotating accent per button so the rows are easy to tell apart. */
const ACCENTS = [
  { bar: 'from-violet-500 to-fuchsia-500', tile: 'bg-violet-500/15 text-violet-500', glow: 'shadow-violet-500/30' },
  { bar: 'from-sky-500 to-cyan-400', tile: 'bg-sky-500/15 text-sky-500', glow: 'shadow-sky-500/30' },
  { bar: 'from-emerald-500 to-teal-400', tile: 'bg-emerald-500/15 text-emerald-500', glow: 'shadow-emerald-500/30' },
  { bar: 'from-amber-500 to-orange-400', tile: 'bg-amber-500/15 text-amber-500', glow: 'shadow-amber-500/30' },
  { bar: 'from-rose-500 to-pink-400', tile: 'bg-rose-500/15 text-rose-500', glow: 'shadow-rose-500/30' },
  { bar: 'from-teal-500 to-lime-400', tile: 'bg-teal-500/15 text-teal-500', glow: 'shadow-teal-500/30' },
];

function pct(n: number, d: number): number {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export default function ButtonClicksPage() {
  const t = useTranslations('ButtonClicks');
  const [days, setDays] = useState<RangeOption>(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [recent, setRecent] = useState<RecentClick[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buttonFilter, setButtonFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async (range: RangeOption) => {
    setLoading(true);
    setError(null);
    try {
      const fromQuery =
        range === 'today'
          ? `&from=${encodeURIComponent(startOfLocalDay().toISOString())}`
          : '';
      const res = await fetch(`/api/button-clicks?days=${range}${fromQuery}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setSummary(data.summary);
      setRecent(data.recent ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(days);
  }, [days, load]);

  const sourceLabel = (c: RecentClick) =>
    c.source === 'broadcast'
      ? c.broadcast?.name ?? t('sourceBroadcast')
      : c.source === 'inbox'
        ? t('sourceInbox')
        : c.source === 'bot'
          ? t('sourceBot')
          : t('sourceUnknown');

  // Same label merged across templates for the "most tapped" bars.
  const buttons = useMemo(() => {
    const m = new Map<string, { button: string; clicks: number; people: number }>();
    for (const b of summary?.by_button ?? []) {
      const cur = m.get(b.button) ?? { button: b.button, clicks: 0, people: 0 };
      cur.clicks += b.clicks;
      cur.people += b.unique_contacts;
      m.set(b.button, cur);
    }
    return [...m.values()].sort((a, b) => b.clicks - a.clicks);
  }, [summary]);

  // Buttons grouped by the message (template) they belong to.
  const byMessage = useMemo(() => {
    const m = new Map<string, Summary['by_button']>();
    for (const b of summary?.by_button ?? []) {
      const key = b.template_name ?? t(`kind.${b.button_kind}`);
      m.set(key, [...(m.get(key) ?? []), b]);
    }
    return [...m.entries()]
      .map(([name, rows]) => ({ name, rows: rows.sort((a, b) => b.clicks - a.clicks), total: rows.reduce((s, r) => s + r.clicks, 0) }))
      .sort((a, b) => b.total - a.total);
  }, [summary, t]);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return recent.filter((c) => {
      const label = c.button_text || c.button_payload || '';
      if (buttonFilter && label !== buttonFilter) return false;
      if (!q) return true;
      return [c.contact?.name, c.contact?.phone, label].some((v) => (v ?? '').toLowerCase().includes(q));
    });
  }, [recent, buttonFilter, query]);

  function exportCsv() {
    const rows = [
      [t('csvName'), t('csvPhone'), t('button'), t('template'), t('source'), t('time')],
      ...people.map((c) => [
        c.contact?.name ?? '',
        c.contact?.phone ?? '',
        c.button_text || c.button_payload || '',
        c.template_name ?? '',
        sourceLabel(c),
        new Date(c.clicked_at).toLocaleString(),
      ]),
    ];
    const blob = new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `button-clicks-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const totals = summary?.totals;
  const maxButton = buttons[0]?.clicks ?? 1;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitleSimple')}</p>
        </div>
        <div className="flex gap-1 overflow-x-auto rounded-full border border-border bg-muted/40 p-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setDays(r)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                days === r ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {loading && days === r && <Loader2 className="h-3 w-3 animate-spin" />}
              {r === 'today' ? t('today') : t('lastDays', { days: r })}
            </button>
          ))}
        </div>
      </div>

      {loading && !summary ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : error ? (
        <div className="flex h-64 flex-col items-center justify-center gap-2">
          <p className="text-sm text-red-400">{error}</p>
          <Button variant="outline" onClick={() => load(days)}>
            {t('retry')}
          </Button>
        </div>
      ) : summary && totals ? (
        <div className={cn('space-y-6 transition-opacity', loading && 'opacity-60')}>
          {/* Plain-language headline */}
          <div className="rounded-2xl border border-border bg-gradient-to-br from-primary/10 via-card to-card p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <MousePointerClick className="h-5 w-5" />
              </span>
              <p className="text-lg font-semibold text-foreground sm:text-xl">
                {t('headline', { clicks: totals.clicks, people: totals.unique_contacts })}
              </p>
            </div>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-background/70 px-3 py-1 text-muted-foreground">
                <Radio className="h-3.5 w-3.5" />
                {t('fromBroadcastsCount', { count: totals.from_broadcasts })}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-background/70 px-3 py-1 text-muted-foreground">
                <MessageSquare className="h-3.5 w-3.5" />
                {t('fromChatsCount', { count: totals.from_inbox + totals.from_bot })}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-background/70 px-3 py-1 text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                {t('peopleCount', { count: totals.unique_contacts })}
              </span>
            </div>
          </div>

          {totals.clicks === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-10 text-center">
              <MousePointerClick className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 font-medium text-foreground">{t('emptyTitle')}</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t('emptyHint')}</p>
            </div>
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                {/* Most tapped buttons */}
                <section className="rounded-2xl border border-border bg-card p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="font-semibold text-foreground">{t('mostTapped')}</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">{t('mostTappedHint')}</p>
                    </div>
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Trophy className="h-4 w-4" />
                    </span>
                  </div>
                  <ul className="mt-4 space-y-2">
                    {buttons.map((b, i) => {
                      const accent = ACCENTS[i % ACCENTS.length];
                      const selected = buttonFilter === b.button;
                      return (
                        <li key={b.button}>
                          <button
                            type="button"
                            onClick={() => setButtonFilter((f) => (f === b.button ? null : b.button))}
                            aria-pressed={selected}
                            className={cn(
                              'group w-full rounded-xl border p-3 text-left transition-all duration-200',
                              selected
                                ? 'border-primary/50 bg-primary/5 shadow-sm'
                                : 'border-transparent hover:-translate-y-px hover:border-border hover:bg-muted/40'
                            )}
                          >
                            <div className="flex items-center gap-3">
                              <span className="relative shrink-0">
                                <span className={cn('flex h-10 w-10 items-center justify-center rounded-xl', accent.tile)}>
                                  <MousePointerClick className="h-4 w-4" />
                                </span>
                                <span className="absolute -top-1.5 -left-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-card bg-foreground text-[10px] font-bold text-background">
                                  {i + 1}
                                </span>
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="truncate text-sm font-semibold text-foreground">{b.button}</span>
                                  <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums', accent.tile)}>
                                    {pct(b.clicks, totals.clicks)}%
                                  </span>
                                </div>
                                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                                  <div
                                    className={cn('h-full rounded-full bg-gradient-to-r shadow-md transition-[width] duration-700 ease-out', accent.bar, accent.glow)}
                                    style={{ width: `${Math.max(4, (b.clicks / maxButton) * 100)}%` }}
                                  />
                                </div>
                                <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                                  <span>
                                    {t('tapsCount', { count: b.clicks })} · {t('peopleCount', { count: b.people })}
                                  </span>
                                  <span className={cn('inline-flex items-center gap-0.5 transition-opacity', selected ? 'text-primary opacity-100' : 'opacity-0 group-hover:opacity-100')}>
                                    {selected ? t('showingPeople') : t('seeWho')}
                                    <ChevronRight className="h-3 w-3" />
                                  </span>
                                </div>
                              </div>
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>

                {/* Per message */}
                <section className="rounded-2xl border border-border bg-card p-5">
                  <h2 className="font-semibold text-foreground">{t('byMessage')}</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t('byMessageHint')}</p>
                  <ul className="mt-4 space-y-3">
                    {byMessage.map((m) => (
                      <li key={m.name} className="rounded-xl border border-border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-foreground">{m.name}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{t('tapsCount', { count: m.total })}</span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {m.rows.map((r) => (
                            <span key={r.button} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs">
                              <span className="text-foreground">{r.button}</span>
                              <span className="font-semibold text-primary tabular-nums">{r.clicks}</span>
                            </span>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>

              {/* Broadcast results */}
              {summary.by_broadcast.length > 0 && (
                <section className="rounded-2xl border border-border bg-card p-5">
                  <h2 className="font-semibold text-foreground">{t('broadcastResults')}</h2>
                  <ul className="mt-4 space-y-4">
                    {summary.by_broadcast.map((b) => {
                      const rate = pct(b.unique_clickers, b.sent_count);
                      return (
                        <li key={b.broadcast_id}>
                          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                            <Link href={`/broadcasts/${b.broadcast_id}`} className="font-medium text-foreground hover:text-primary">
                              {b.name}
                            </Link>
                            <span className="text-xs text-muted-foreground">
                              {t('broadcastLine', { sent: b.sent_count, tapped: b.unique_clickers })} ·{' '}
                              <span className="font-semibold text-primary">{rate}%</span>
                            </span>
                          </div>
                          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(2, rate))}%` }} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {/* Who tapped */}
              <section className="rounded-2xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold text-foreground">{t('whoTapped')}</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t('whoTappedHint')}</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={exportCsv} disabled={!people.length}>
                    <Download className="h-3.5 w-3.5" />
                    {t('exportCsv')}
                  </Button>
                </div>

                <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="relative w-full sm:max-w-xs">
                    <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t('searchPeople')}
                      className="h-9 rounded-full pr-8 pl-9"
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
                  {buttonFilter && (
                    <button
                      type="button"
                      onClick={() => setButtonFilter(null)}
                      className="inline-flex items-center gap-1.5 self-start rounded-full border border-primary bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
                    >
                      {t('filteredBy', { button: buttonFilter })}
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {people.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">{t('noPeople')}</p>
                ) : (
                  <ul className="mt-4 divide-y divide-border">
                    {people.map((c) => {
                      const name = c.contact?.name || c.contact?.phone || t('unknownContact');
                      return (
                        <li key={c.id} className="flex flex-wrap items-center gap-3 py-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                            {name.slice(0, 1).toUpperCase()}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-foreground">{name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {c.contact?.phone && c.contact.phone !== name ? `${c.contact.phone} · ` : ''}
                              {sourceLabel(c)} · {formatDistanceToNow(new Date(c.clicked_at), { addSuffix: true })}
                            </p>
                          </div>
                          <span className="max-w-[45%] truncate rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
                            {c.button_text || c.button_payload}
                            {c.card_index !== null && <span className="ml-1 text-muted-foreground">({t('card', { n: c.card_index + 1 })})</span>}
                          </span>
                          <div className="flex gap-1">
                            {c.contact?.phone && (
                              <a
                                href={`tel:${c.contact.phone}`}
                                aria-label={t('call')}
                                className={buttonVariants({ size: 'icon', variant: 'ghost' })}
                              >
                                <PhoneOutgoing className="h-4 w-4" />
                              </a>
                            )}
                            {c.conversation_id && (
                              <Link
                                href={`/inbox?c=${c.conversation_id}`}
                                aria-label={t('openChat')}
                                className={buttonVariants({ size: 'icon', variant: 'ghost' })}
                              >
                                <MessageSquare className="h-4 w-4" />
                              </Link>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
