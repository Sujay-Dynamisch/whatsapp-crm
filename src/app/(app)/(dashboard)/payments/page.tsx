'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  BadgeCheck,
  Ban,
  CircleDollarSign,
  Clock,
  Copy,
  Loader2,
  PhoneOutgoing,
  RefreshCw,
  Search,
  Send,
  Undo2,
  Wallet,
  X,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';

type Status = 'pending' | 'paid' | 'closed';
type Filter = Status | 'all';

interface Lead {
  contact_id: string;
  status: Status;
  link_sent_at: string | null;
  paid_at: string | null;
  amount: number | null;
  method: string | null;
  note: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  in_journey: boolean;
  next_message_at: string | null;
}

interface Data {
  leads: Lead[];
  stats: { pending: number; paid: number; closed: number; paid_today: number; amount_total: number; currency: string };
}

const FILTERS: Filter[] = ['pending', 'paid', 'closed', 'all'];
const METHODS = ['upi', 'card', 'netbanking', 'cash', 'other'] as const;

const STATUS_STYLE: Record<Status, string> = {
  pending: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  paid: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  closed: 'border-border bg-muted text-muted-foreground',
};

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

export default function PaymentsPage() {
  const t = useTranslations('Payments');
  const { canSendMessages } = useAuth();
  const [data, setData] = useState<Data | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>('pending');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [marking, setMarking] = useState<Lead | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<(typeof METHODS)[number]>('upi');
  const [note, setNote] = useState('');

  useEffect(() => {
    const id = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ status: filter, tz: String(new Date().getTimezoneOffset()) });
      if (search) qs.set('q', search);
      const res = await fetch(`/api/payments?${qs}`);
      const json = await res.json().catch(() => ({}));
      if (res.status === 404 && json?.error === 'not_enabled') {
        setNotEnabled(true);
        return;
      }
      if (!res.ok) {
        toast.error(json?.error || t('loadFailed'));
        return;
      }
      setData(json);
    } finally {
      setLoading(false);
    }
  }, [filter, search, t]);

  useEffect(() => {
    void load();
  }, [load]);

  function openMarkPaid(lead: Lead) {
    setMarking(lead);
    setAmount('');
    setMethod('upi');
    setNote('');
  }

  async function confirmPaid() {
    if (!marking) return;
    setBusyId(marking.contact_id);
    try {
      const res = await fetch('/api/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: marking.contact_id, amount: amount || null, method, note }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || t('saveFailed'));
        return;
      }
      toast.success(
        json.journeys_stopped
          ? t('markedPaidStopped', { name: nameOf(marking) })
          : t('markedPaid', { name: nameOf(marking) })
      );
      setMarking(null);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function markNotPaid(lead: Lead) {
    if (!(await confirmDialog({ title: t('undoConfirm', { name: nameOf(lead) }), description: t('undoConfirmDesc'), destructive: true, confirmLabel: t('markNotPaid') }))) return;
    setBusyId(lead.contact_id);
    try {
      const res = await fetch(`/api/payments/${lead.contact_id}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || t('saveFailed'));
        return;
      }
      toast.success(t('markedNotPaid', { name: nameOf(lead) }));
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function copy(phone: string) {
    try {
      await navigator.clipboard.writeText(phone);
      toast.success(t('copied'));
    } catch {
      toast.error(phone);
    }
  }

  const nameOf = (l: Lead) => l.contact_name || l.contact_phone || t('unknown');
  const stats = data?.stats;
  const conversion = useMemo(() => {
    if (!stats) return null;
    const total = stats.paid + stats.pending + stats.closed;
    return total ? Math.round((stats.paid / total) * 100) : 0;
  }, [stats]);

  if (notEnabled) {
    return (
      <div className="rounded-2xl border border-dashed border-border p-10 text-center">
        <Wallet className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-3 font-medium text-foreground">{t('notEnabledTitle')}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t('notEnabledHint')}</p>
      </div>
    );
  }

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

      {/* Stats strip */}
      <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-border bg-card sm:grid-cols-4">
        {[
          { label: t('statPending'), value: stats?.pending, icon: Clock, tone: 'text-amber-500 bg-amber-500/10' },
          { label: t('statPaid'), value: stats?.paid, icon: BadgeCheck, tone: 'text-emerald-500 bg-emerald-500/10', sub: stats ? t('paidToday', { count: stats.paid_today }) : '' },
          { label: t('statCollected'), value: stats ? money(stats.amount_total, stats.currency) : undefined, icon: CircleDollarSign, tone: 'text-primary bg-primary/10' },
          { label: t('statConversion'), value: conversion === null ? undefined : `${conversion}%`, icon: Send, tone: 'text-sky-500 bg-sky-500/10' },
        ].map((s, i) => (
          <div
            key={s.label}
            className={cn('flex items-center gap-3 px-4 py-3', i % 2 === 1 && 'border-l border-border', i >= 2 && 'border-t border-border sm:border-t-0', i === 2 && 'sm:border-l')}
          >
            <span className={cn('hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:flex', s.tone)}>
              <s.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-xl leading-tight font-bold tabular-nums text-foreground">{s.value ?? '—'}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {s.label}
                {s.sub ? ` · ${s.sub}` : ''}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
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
        <div className="flex max-w-full gap-0.5 overflow-x-auto rounded-full border border-border bg-muted/40 p-0.5">
          {FILTERS.map((f) => {
            const count = f === 'all' ? undefined : stats?.[f];
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  filter === f ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {loading && filter === f && <Loader2 className="h-3 w-3 animate-spin" />}
                {t(`filter.${f}`)}
                {count !== undefined && <span className="tabular-nums text-muted-foreground">{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* List */}
      {data === null ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : data.leads.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center">
          <Wallet className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 font-medium text-foreground">{search ? t('noResults') : t(`empty.${filter}`)}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t('emptyHint')}</p>
        </div>
      ) : (
        <ul className={cn('grid gap-3 transition-opacity xl:grid-cols-2', loading && 'pointer-events-none opacity-50')}>
          {data.leads.map((l) => {
            const name = nameOf(l);
            const busy = busyId === l.contact_id;
            return (
              <li key={l.contact_id} className={cn('rounded-2xl border border-border bg-card p-4 transition-shadow hover:shadow-md', busy && 'opacity-60')}>
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
                      l.status === 'paid' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-primary/10 text-primary'
                    )}
                  >
                    {l.status === 'paid' ? <BadgeCheck className="h-5 w-5" /> : name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-semibold text-foreground">{name}</p>
                      <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', STATUS_STYLE[l.status])}>
                        {t(`status.${l.status}`)}
                      </span>
                    </div>
                    {l.contact_phone && (
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <a href={`tel:${l.contact_phone}`} className="text-sm font-medium tabular-nums text-foreground hover:text-primary">
                          {l.contact_phone}
                        </a>
                        <button
                          type="button"
                          onClick={() => void copy(l.contact_phone!)}
                          aria-label={t('copy')}
                          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {l.link_sent_at && (
                        <p>
                          {t('linkSent', {
                            when: formatDistanceToNow(new Date(l.link_sent_at), { addSuffix: true }),
                          })}
                        </p>
                      )}
                      {l.status === 'paid' && l.paid_at && (
                        <p className="font-medium text-emerald-600 dark:text-emerald-400">
                          {t('paidLine', {
                            amount: l.amount !== null ? money(Number(l.amount), stats?.currency ?? 'INR') : t('amountUnknown'),
                            method: l.method ? t(`method.${l.method}`) : '—',
                            when: format(new Date(l.paid_at), 'MMM d, h:mm a'),
                          })}
                        </p>
                      )}
                      {l.status === 'pending' && l.in_journey && (
                        <p className="text-amber-600 dark:text-amber-400">
                          {l.next_message_at
                            ? t('remindersActive', { when: format(new Date(l.next_message_at), 'MMM d, h:mm a') })
                            : t('remindersActiveNoTime')}
                        </p>
                      )}
                      {l.note && <p className="italic">“{l.note}”</p>}
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {canSendMessages && l.status !== 'paid' && (
                    <Button
                      size="sm"
                      className="bg-emerald-600 text-white hover:bg-emerald-600/90"
                      disabled={busy}
                      onClick={() => openMarkPaid(l)}
                    >
                      <BadgeCheck className="h-3.5 w-3.5" />
                      {t('markPaid')}
                    </Button>
                  )}
                  {l.contact_phone && (
                    <a href={`tel:${l.contact_phone}`} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                      <PhoneOutgoing className="h-3.5 w-3.5" />
                      {t('call')}
                    </a>
                  )}
                  {canSendMessages && l.status === 'paid' && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void markNotPaid(l)}>
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
                      {t('markNotPaid')}
                    </Button>
                  )}
                  {l.status === 'closed' && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Ban className="h-3.5 w-3.5" />
                      {t('closedHint')}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Mark as paid */}
      <Dialog open={!!marking} onOpenChange={(o) => !o && setMarking(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('dialogTitle', { name: marking ? nameOf(marking) : '' })}</DialogTitle>
            <DialogDescription>{t('dialogDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pay-amount">{t('amount')}</Label>
              <Input
                id="pay-amount"
                type="number"
                min={0}
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={t('amountPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('methodLabel')}</Label>
              <div className="flex flex-wrap gap-1.5">
                {METHODS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMethod(m)}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                      method === m ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t(`method.${m}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-note">{t('noteLabel')}</Label>
              <Input id="pay-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={t('notePlaceholder')} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMarking(null)}>
              {t('cancel')}
            </Button>
            <Button className="bg-emerald-600 text-white hover:bg-emerald-600/90" onClick={() => void confirmPaid()} disabled={busyId !== null}>
              {busyId ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />}
              {t('confirmPaid')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
