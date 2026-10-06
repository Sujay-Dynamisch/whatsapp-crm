'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { Loader2, MousePointerClick, Users, Radio, MessageSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const RANGES = [7, 30, 90] as const;

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

function pct(n: number, d: number): string {
  if (!d) return '—';
  return `${Math.round((n / d) * 1000) / 10}%`;
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-bold text-foreground">{value.toLocaleString()}</p>
    </div>
  );
}

export default function ButtonClicksPage() {
  const t = useTranslations('ButtonClicks');
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [recent, setRecent] = useState<RecentClick[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (range: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/button-clicks?days=${range}`);
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex gap-1 rounded-lg border border-border p-1">
          {RANGES.map((r) => (
            <Button
              key={r}
              size="sm"
              variant={days === r ? 'default' : 'ghost'}
              onClick={() => setDays(r)}
            >
              {t('lastDays', { days: r })}
            </Button>
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
      ) : summary ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label={t('totalClicks')}
              value={summary.totals.clicks}
              icon={<MousePointerClick className="h-4 w-4" />}
            />
            <StatCard
              label={t('uniqueContacts')}
              value={summary.totals.unique_contacts}
              icon={<Users className="h-4 w-4" />}
            />
            <StatCard
              label={t('fromBroadcasts')}
              value={summary.totals.from_broadcasts}
              icon={<Radio className="h-4 w-4" />}
            />
            <StatCard
              label={t('fromChats')}
              value={summary.totals.from_inbox + summary.totals.from_bot}
              icon={<MessageSquare className="h-4 w-4" />}
            />
          </div>

          {summary.totals.clicks === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-10 text-center">
              <MousePointerClick className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 font-medium text-foreground">{t('emptyTitle')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t('emptyHint')}</p>
            </div>
          ) : (
            <>
              {summary.by_broadcast.length > 0 && (
                <section className="space-y-2">
                  <h2 className="text-sm font-semibold text-foreground">{t('byBroadcast')}</h2>
                  <div className="rounded-xl border border-border bg-card">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('broadcast')}</TableHead>
                          <TableHead className="hidden md:table-cell">{t('template')}</TableHead>
                          <TableHead className="text-right">{t('sent')}</TableHead>
                          <TableHead className="text-right">{t('clicks')}</TableHead>
                          <TableHead className="text-right">{t('uniqueClickers')}</TableHead>
                          <TableHead className="text-right">{t('clickRate')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {summary.by_broadcast.map((b) => (
                          <TableRow key={b.broadcast_id}>
                            <TableCell>
                              <Link
                                href={`/broadcasts/${b.broadcast_id}`}
                                className="font-medium text-foreground hover:text-primary"
                              >
                                {b.name}
                              </Link>
                            </TableCell>
                            <TableCell className="hidden text-muted-foreground md:table-cell">
                              {b.template_name}
                            </TableCell>
                            <TableCell className="text-right">{b.sent_count}</TableCell>
                            <TableCell className="text-right">{b.clicks}</TableCell>
                            <TableCell className="text-right">{b.unique_clickers}</TableCell>
                            <TableCell className="text-right font-medium text-primary">
                              {pct(b.unique_clickers, b.sent_count)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </section>
              )}

              <section className="space-y-2">
                <h2 className="text-sm font-semibold text-foreground">{t('byButton')}</h2>
                <div className="rounded-xl border border-border bg-card">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('button')}</TableHead>
                        <TableHead className="hidden md:table-cell">{t('template')}</TableHead>
                        <TableHead className="text-right">{t('clicks')}</TableHead>
                        <TableHead className="text-right">{t('uniqueContacts')}</TableHead>
                        <TableHead className="hidden text-right sm:table-cell">{t('lastClick')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.by_button.map((b, i) => (
                        <TableRow key={`${b.button}-${b.template_name}-${b.button_kind}-${i}`}>
                          <TableCell className="font-medium text-foreground">{b.button}</TableCell>
                          <TableCell className="hidden text-muted-foreground md:table-cell">
                            {b.template_name ?? t(`kind.${b.button_kind}`)}
                          </TableCell>
                          <TableCell className="text-right">{b.clicks}</TableCell>
                          <TableCell className="text-right">{b.unique_contacts}</TableCell>
                          <TableCell className="hidden text-right text-muted-foreground sm:table-cell">
                            {format(new Date(b.last_clicked_at), 'MMM d, HH:mm')}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>

              <section className="space-y-2">
                <h2 className="text-sm font-semibold text-foreground">{t('recent')}</h2>
                <div className="rounded-xl border border-border bg-card">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('contact')}</TableHead>
                        <TableHead>{t('button')}</TableHead>
                        <TableHead className="hidden md:table-cell">{t('source')}</TableHead>
                        <TableHead className="text-right">{t('time')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recent.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell>
                            {c.conversation_id ? (
                              <Link
                                href={`/inbox?c=${c.conversation_id}`}
                                className="text-foreground hover:text-primary"
                              >
                                {c.contact?.name || c.contact?.phone || t('unknownContact')}
                              </Link>
                            ) : (
                              <span className="text-muted-foreground">{t('unknownContact')}</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <span className="font-medium text-foreground">
                              {c.button_text || c.button_payload}
                            </span>
                            {c.card_index !== null && (
                              <span className="ml-1.5 text-xs text-muted-foreground">
                                {t('card', { n: c.card_index + 1 })}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="hidden text-muted-foreground md:table-cell">
                            {sourceLabel(c)}
                            {c.template_name && c.source !== 'broadcast' ? ` · ${c.template_name}` : ''}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {format(new Date(c.clicked_at), 'MMM d, HH:mm')}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
