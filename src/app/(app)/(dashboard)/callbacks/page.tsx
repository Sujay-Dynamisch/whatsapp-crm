'use client';

import { PageGuide } from '@/components/guide/page-guide';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  AlarmClock,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  CreditCard,
  Flame,
  FlameKindling,
  Info,
  Loader2,
  MessageSquare,
  PartyPopper,
  PhoneCall,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  RefreshCw,
  Repeat,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  StickyNote,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Hint } from '@/components/ui/hint';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import { CallbackNoteDialog } from '@/components/callbacks/callback-note-dialog';
import { CallbackDetailsSheet } from '@/components/callbacks/callback-details-sheet';
import { TrashButton } from '@/components/trash/trash-sheet';
import { NotOnWhatsappPanel } from '@/components/callbacks/not-on-whatsapp-panel';
type Status = 'new' | 'called' | 'no_answer' | 'done';
type StatusFilter = 'open' | 'priority' | Status | 'all';
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
  /** "No answer" marks so far (migration 059). */
  no_answer_count?: number;
  /** Caller management (086): 'high' = the customer asked for a call. */
  priority?: 'normal' | 'high';
  source_kind?: string | null;
  caller_name?: string | null;
  note_by_name?: string | null;
  note_at?: string | null;
  ai_meta?: { confidence?: number; requested_time?: string; language?: string } | null;
  /** When the customer asked to be called (102). */
  scheduled_for?: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  /** Number has no WhatsApp — phone only (not-on-whatsapp.ts). */
  not_on_whatsapp?: boolean;
}

interface Data {
  requests: CallbackRequest[];
  /** Matching requests on the server (the list is paged). */
  total?: number | null;
  stats: { open: number; priority?: number; today: number; handled_today: number };
  daily: { date: string; count: number }[];
}

type FollowUpReason = 'not_in_journey' | 'not_configured' | 'opted_out' | 'not_on_whatsapp' | 'closed' | 'busy' | 'start_failed';
interface NoAnswerFollowUp {
  action: 'messaged' | 'returned' | 'none';
  reason?: FollowUpReason;
  count: number;
  limit: number;
}

const STATUS_FILTERS: StatusFilter[] = ['open', 'priority', 'new', 'called', 'no_answer', 'done', 'all'];
const DAY_FILTERS: DayFilter[] = ['today', 'yesterday', 'week', 'all'];
/** A new request older than this is highlighted as overdue. */
const OVERDUE_MS = 2 * 3600_000;
const PAGE_SIZE = 10;
/** Big, easy-to-tap outcome buttons. */
const OUTCOME_BTN = 'h-10 rounded-xl px-3.5 text-sm';

const STATUS_ICON: Record<Status, typeof Clock> = {
  new: Clock,
  called: PhoneCall,
  no_answer: PhoneMissed,
  done: CheckCircle2,
};

const STATUS_BAR: Record<Status, string> = {
  new: 'bg-amber-500',
  called: 'bg-sky-500',
  no_answer: 'bg-rose-500',
  done: 'bg-emerald-500',
};

const STATUS_STYLE: Record<Status, string> = {
  new: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  called: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  no_answer: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400',
  done: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
};

/** What each "Show" tab actually means — a non-technical caller can hover to check. */
const FILTER_HINT: Record<StatusFilter, string> = {
  open: 'Everything that still needs a call: not called yet, or they did not pick up.',
  priority: 'Only people who asked for a call themselves. Call these first.',
  new: 'Nobody has called them yet.',
  called: 'You called them, but it is not marked done yet.',
  no_answer: 'You called and they did not answer.',
  done: 'Finished — nothing more to do here.',
  all: 'Every request, whatever its status.',
};
const DAY_HINT: Record<DayFilter, string> = {
  today: 'Requests asked for today only.',
  yesterday: 'Requests asked for yesterday only.',
  week: 'Requests asked for in the last 7 days.',
  all: 'Every request ever asked for.',
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
  const { canSendMessages, canManageMembers } = useAuth();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'requests' | 'nowa'>('requests');
  const [nowaCount, setNowaCount] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [dayFilter, setDayFilter] = useState<DayFilter>('all');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [detailsKey, setDetailsKey] = useState(0);

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

  // Next page from the server (the API sends 60 at a time).
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = useCallback(async () => {
    if (!data) return;
    setLoadingMore(true);
    try {
      const qs = new URLSearchParams({ offset: String(data.requests.length) });
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
      setData((d) => {
        if (!d) return d;
        const seen = new Set(d.requests.map((r) => r.id));
        return { ...d, requests: [...d.requests, ...(json.requests ?? []).filter((r: { id: string }) => !seen.has(r.id))] };
      });
    } finally {
      setLoadingMore(false);
    }
  }, [data, statusFilter, dayFilter, search, t]);

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
      // "No answer": say what happened to the lead.
      const f = json?.followup as NoAnswerFollowUp | null | undefined;
      if (patch.status === 'no_answer' && f) {
        if (f.action === 'messaged') toast.success(t('followMessaged'), { description: t('followMessagedHint', { left: f.limit - f.count }) });
        else if (f.action === 'returned') toast.success(t('followReturned', { count: f.count }));
        else toast.success(okMsg, f.reason ? { description: t(`reason.${f.reason}`) } : undefined);
      } else {
        toast.success(okMsg);
      }
      await load();
      setDetailsKey((k) => k + 1);
    } finally {
      setBusyId(null);
    }
  }

  async function sendPaymentLink(r: CallbackRequest) {
    const ok = await confirmDialog({
      title: `Send the payment link to ${r.contact_name || r.contact_phone || 'this lead'}?`,
      description:
        'The lead gets the payment link on WhatsApp right away. It is added to the timeline, the lead is tagged "payment_link_sent", and the journey will not send its automatic payment link again.',
      confirmLabel: 'Send payment link',
    });
    if (!ok) return;
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/callbacks/${r.id}/payment-link`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || 'Could not send the payment link');
        return;
      }
      toast.success('Payment link sent on WhatsApp');
      setDetailsKey((k) => k + 1);
    } finally {
      setBusyId(null);
    }
  }

  // Sends the journey's "We tried calling you" message (the same step a
  // "No answer" sends, with its Call me again / Not now buttons). Fixed —
  // the caller never types their own message here. Status is unchanged.
  async function sendMessage(r: CallbackRequest) {
    const ok = await confirmDialog({
      title: `Tell ${r.contact_name || r.contact_phone || 'this lead'} you tried calling?`,
      description: 'Sends the "We tried calling you" WhatsApp message right away — the same one a "Didn\'t pick up" sends, with Call me again / Not now buttons. It is a fixed message, and the request status does not change.',
      confirmLabel: 'Send callback request message',
    });
    if (!ok) return;
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/callbacks/${r.id}/message`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.reason ? t(`reason.${json.reason}`) : json?.error || 'Could not send the message');
        return;
      }
      toast.success('"We tried calling you" message sent on WhatsApp');
      setDetailsKey((k) => k + 1);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(r: CallbackRequest) {
    const ok = await confirmDialog({
      title: `Delete the callback request of ${r.contact_name || r.contact_phone || 'this lead'}?`,
      description: 'It moves to the Trash with its notes and timeline. An admin can restore it from there.',
      confirmLabel: 'Move to Trash',
      destructive: true,
    });
    if (!ok) return;
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/callbacks/${r.id}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || t('updateFailed'));
        return;
      }
      toast.success('Moved to Trash');
      if (detailsId === r.id) setDetailsId(null);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function backToNurture(r: CallbackRequest) {
    const ok = await confirmDialog({
      title: t('backToNurtureTitle', { name: r.contact_name || r.contact_phone || '' }),
      description: t('backToNurtureBody'),
      confirmLabel: t('backToNurture'),
    });
    if (!ok) return;
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/callbacks/${r.id}/nurture`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.reason ? t(`reason.${json.reason}`) : json?.error || t('updateFailed'));
        return;
      }
      toast.success(t('backedToNurture'));
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const [noteFor, setNoteFor] = useState<CallbackRequest | null>(null);
  function editNote(r: CallbackRequest) {
    setNoteFor(r);
  }

  async function togglePriority(r: CallbackRequest) {
    const next = r.priority === 'high' ? 'normal' : 'high';
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/callbacks/${r.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || t('updateFailed'));
        return;
      }
      toast.success(next === 'high' ? 'Marked as Priority' : 'Priority removed');
      await load();
      setDetailsKey((k) => k + 1);
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

  const maxDaily = useMemo(() => Math.max(1, ...(data?.daily ?? []).map((d) => d.count)), [data]);
  const now = Date.now();

  useEffect(() => {
    let live = true;
    fetch('/api/not-on-whatsapp')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => live && j && setNowaCount((j.leads ?? []).length))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Show 10 at a time; resets when the filters change.
  const filterKey = `${statusFilter}|${dayFilter}|${search}`;
  const [page, setPage] = useState({ key: filterKey, n: PAGE_SIZE });
  const visibleN = page.key === filterKey ? page.n : PAGE_SIZE;
  // "Call next": the top open request (the API sorts Priority first, then oldest).
  const nextUp = !search && statusFilter !== 'done' ? (data?.requests.find((r) => r.status !== 'done') ?? null) : null;
  const rest = (data?.requests ?? []).filter((r) => r.id !== nextUp?.id);
  // All matching requests on the server (the list loads them page by page).
  const restTotal = Math.max(rest.length, (data?.total ?? rest.length) - (nextUp ? 1 : 0));

  function renderCard(r: CallbackRequest, hero: boolean) {
    const name = r.contact_name || r.contact_phone || t('unknown');
    const overdue = r.status === 'new' && now - Date.parse(r.requested_at) > OVERDUE_MS;
    const busy = busyId === r.id;
    const open = r.status !== 'done';
    const priority = r.priority === 'high' && open;
    const callDue = !!r.scheduled_for && Date.parse(r.scheduled_for) <= now;
    const chip = 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium';
    const StatusIcon = STATUS_ICON[r.status];
    return (
      <article
        aria-label={name}
        onClick={() => setDetailsId(r.id)}
        className={cn(
          'relative cursor-pointer overflow-hidden rounded-2xl border bg-card transition-shadow hover:shadow-md',
          hero ? 'border-primary/50 p-5 shadow-sm ring-4 ring-primary/10 sm:p-6' : 'p-4',
          !hero && (overdue ? 'border-rose-500/50' : priority ? 'border-amber-500/60' : 'border-border'),
          busy && 'opacity-60'
        )}
      >
        <span className={cn('absolute inset-y-0 left-0 w-1.5', STATUS_BAR[r.status])} aria-hidden />
        <div className="flex items-start gap-3 pl-1.5">
          <div
            className={cn(
              'flex shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-violet-500 font-semibold text-white shadow-sm',
              hero ? 'h-14 w-14 text-base' : 'h-12 w-12 text-sm'
            )}
            aria-hidden
          >
            {initials(name) || <PhoneCall className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className={cn('truncate font-semibold text-foreground', hero ? 'text-xl' : 'text-base')}>{name}</p>
                <span className={cn('mt-1 border', chip, STATUS_STYLE[r.status])}>
                  <StatusIcon className="h-3.5 w-3.5" aria-hidden />
                  {t(`status.${r.status}`)}
                </span>
                {r.not_on_whatsapp && (
                  <Hint text="WhatsApp messages can't reach this number. Call them and ask for their WhatsApp number (see the Not on WhatsApp tab).">
                    <span className={cn('mt-1 ml-1.5 border border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-300', chip)}>
                      <PhoneOff className="h-3.5 w-3.5" aria-hidden />
                      Not on WhatsApp — call only
                    </span>
                  </Hint>
                )}
              </div>
              <Hint text="See this person's full history, tags and notes.">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 shrink-0 rounded-lg text-primary"
                  aria-label={`Open details for ${name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDetailsId(r.id);
                  }}
                >
                  Details <ChevronRight className="h-4 w-4" aria-hidden />
                </Button>
              </Hint>
            </div>

            {/* What needs attention — always words, never colour alone */}
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {priority && (
                <span className={cn(chip, 'bg-amber-500 text-white')}>
                  <Flame className="h-3.5 w-3.5" aria-hidden /> Customer asked for a call
                </span>
              )}
              {overdue && (
                <span className={cn(chip, 'bg-rose-500/15 text-rose-700 dark:text-rose-300')}>
                  <AlarmClock className="h-3.5 w-3.5" aria-hidden /> Waiting 2+ hours
                </span>
              )}
              {r.scheduled_for && open && (
                <span
                  className={cn(chip, callDue ? 'bg-rose-500 text-white' : 'bg-sky-500/15 text-sky-700 dark:text-sky-300')}
                  title="The time the customer asked to be called"
                >
                  <CalendarClock className="h-3.5 w-3.5" aria-hidden />
                  Call at {format(new Date(r.scheduled_for), 'h:mm a, EEE d MMM')}
                  {callDue ? ' — now' : ''}
                </span>
              )}
              {r.source_kind === 'engagement' && r.priority !== 'high' && (
                <span className={cn(chip, 'border border-border text-muted-foreground')}>
                  <Sparkles className="h-3.5 w-3.5" aria-hidden /> New lead
                </span>
              )}
              {r.source_kind === 'ai_inbox_text' && (
                <span className={cn(chip, 'border border-violet-500/40 text-violet-700 dark:text-violet-300')}>
                  <MessageSquare className="h-3.5 w-3.5" aria-hidden /> Asked in chat
                  {r.ai_meta?.requested_time ? ` · ${r.ai_meta.requested_time}` : ''}
                </span>
              )}
              {r.source_kind === 'ai_review' && open && (
                <span className={cn(chip, 'border border-amber-500/50 text-amber-800 dark:text-amber-300')}>
                  <Info className="h-3.5 w-3.5" aria-hidden /> Check the chat first
                  {typeof r.ai_meta?.confidence === 'number' ? ` · ${Math.round(r.ai_meta.confidence * 100)}% sure` : ''}
                </span>
              )}
              {(r.no_answer_count ?? 0) > 0 && (
                <span className={cn(chip, 'border border-rose-500/30 text-rose-700 dark:text-rose-300')}>
                  <PhoneMissed className="h-3.5 w-3.5" aria-hidden /> {t('noAnswerTimes', { count: r.no_answer_count ?? 0 })}
                </span>
              )}
              {r.caller_name && (
                <span className={cn(chip, 'border border-border text-muted-foreground')}>
                  <UserRound className="h-3.5 w-3.5" aria-hidden /> {r.caller_name}
                </span>
              )}
            </div>

            {r.contact_phone && (
              <div className="mt-2 flex items-center gap-1">
                <a
                  href={`tel:${r.contact_phone}`}
                  onClick={(e) => e.stopPropagation()}
                  className={cn('rounded-md font-semibold tracking-wide text-foreground tabular-nums hover:text-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none', hero ? 'text-2xl' : 'text-lg')}
                >
                  {r.contact_phone}
                </a>
                <Hint text="Copy this phone number.">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void copy(r.contact_phone!);
                    }}
                    aria-label={t('copy')}
                    className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </Hint>
              </div>
            )}
            <p className={cn('mt-0.5 text-sm', overdue ? 'font-medium text-rose-600 dark:text-rose-400' : 'text-muted-foreground')}>
              {t('requested', {
                when: formatDistanceToNow(new Date(r.requested_at), { addSuffix: true }),
                time: format(new Date(r.requested_at), 'MMM d, h:mm a'),
              })}
            </p>
            {r.source && (
              <p className="mt-2.5 flex max-w-full items-start gap-1.5 rounded-xl bg-muted px-3 py-2 text-sm text-muted-foreground">
                <span className="shrink-0">{t('said')}</span>
                <span className="font-medium break-words text-foreground">“{r.source}”</span>
              </p>
            )}
            {r.note && (
              <div className="mt-2.5 rounded-xl border border-amber-500/25 bg-amber-500/8 px-3 py-2">
                <p className="flex items-start gap-1.5 text-sm text-foreground">
                  <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                  <span className="break-words">{r.note}</span>
                </p>
                {(r.note_by_name || r.note_at) && (
                  <p className="mt-1 pl-5.5 text-xs text-muted-foreground">
                    {r.note_by_name ? `— ${r.note_by_name}` : ''}
                    {r.note_at ? `${r.note_by_name ? ' · ' : ''}${formatDistanceToNow(new Date(r.note_at), { addSuffix: true })}` : ''}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Actions: call first, then "what happened?", the rest under More */}
        <div className="mt-4 space-y-3 border-t border-border pt-4" onClick={(e) => e.stopPropagation()}>
          <div className="flex flex-wrap gap-2">
            {r.contact_phone && (
              <Hint text="Opens your phone's dialler to call this number.">
                <a
                  href={`tel:${r.contact_phone}`}
                  className={cn(buttonVariants(), 'h-11 flex-1 rounded-xl bg-emerald-600 px-5 text-base text-white hover:bg-emerald-700 sm:flex-none')}
                >
                  <PhoneOutgoing className="h-4 w-4" aria-hidden />
                  {t('call')} {r.contact_name ? r.contact_name.split(' ')[0] : ''}
                </a>
              </Hint>
            )}
            {r.conversation_id && !r.not_on_whatsapp && (
              <Hint text="See and reply to their WhatsApp messages in the Inbox.">
                <Link href={`/inbox?c=${r.conversation_id}`} className={cn(buttonVariants({ variant: 'outline' }), 'h-11 flex-1 rounded-xl sm:flex-none')}>
                  <MessageSquare className="h-4 w-4" aria-hidden />
                  {t('openChat')}
                </Link>
              </Hint>
            )}
          </div>

          {canSendMessages && (
            <div className="flex flex-wrap items-center gap-2">
              {open ? (
                <>
                  <span className="w-full text-xs font-medium text-muted-foreground sm:w-auto">After the call:</span>
                  {r.status !== 'called' && (
                    <Hint text="You talked to them on the phone. Takes this off Priority, but keeps it on your list until you mark it done.">
                      <Button variant="outline" disabled={busy} className={OUTCOME_BTN} onClick={() => void update(r, { status: 'called' }, t('markedCalled'))}>
                        <PhoneCall className="h-4 w-4 text-sky-600 dark:text-sky-400" aria-hidden />
                        {t('markCalled')}
                      </Button>
                    </Hint>
                  )}
                  {/* Every "No answer" counts as an attempt (2nd → back to nurture). */}
                  <Hint text="They did not answer. We text them automatically — after too many missed calls, automatic messages take over instead of calls.">
                    <Button variant="outline" disabled={busy} className={OUTCOME_BTN} onClick={() => void update(r, { status: 'no_answer' }, t('markedNoAnswer'))}>
                      <PhoneMissed className="h-4 w-4 text-rose-600 dark:text-rose-400" aria-hidden />
                      {(r.no_answer_count ?? 0) > 0 ? t('markNoAnswerAgain') : t('markNoAnswer')}
                    </Button>
                  </Hint>
                  <Hint text="Marks this finished and removes it from your call list.">
                    <Button
                      variant="outline"
                      disabled={busy}
                      className={cn(OUTCOME_BTN, 'border-emerald-500/50 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400')}
                      onClick={() => void update(r, { status: 'done' }, t('markedDone'))}
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
                      {t('markDone')}
                    </Button>
                  </Hint>
                </>
              ) : (
                <Hint text="Put this back on your call list as waiting.">
                  <Button variant="outline" disabled={busy} className={OUTCOME_BTN} onClick={() => void update(r, { status: 'new' }, t('reopened'))}>
                    <RotateCcw className="h-4 w-4" aria-hidden />
                    {t('reopen')}
                  </Button>
                </Hint>
              )}
              <Hint text="Write down what was said. This also takes it off the Priority list.">
                <Button variant="ghost" disabled={busy} className={OUTCOME_BTN} onClick={() => void editNote(r)}>
                  <StickyNote className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden />
                  {r.note ? t('editNote') : t('addNote')}
                </Button>
              </Hint>
              {!r.not_on_whatsapp && (<>
              <Hint text="Sends the payment link to this person on WhatsApp right now.">
                <Button variant="ghost" disabled={busy} className={OUTCOME_BTN} onClick={() => void sendPaymentLink(r)}>
                  <CreditCard className="h-4 w-4 text-primary" aria-hidden />
                  Send payment link
                </Button>
              </Hint>
              <Hint text="Sends the fixed 'We tried calling you' WhatsApp message (with Call me again / Not now buttons) — use it after a missed call. Does not change the status.">
                <Button variant="ghost" disabled={busy} className={OUTCOME_BTN} onClick={() => void sendMessage(r)}>
                  <Send className="h-4 w-4 text-primary" aria-hidden />
                  Send callback request message
                </Button>
              </Hint>
              </>)}
              {open && r.status !== 'called' && (!priority || canManageMembers) && (
                <Hint
                  text={
                    priority
                      ? 'Takes this off the Priority list.'
                      : 'Flag this as urgent so it shows at the top and in Priority, even if the customer did not ask for a call themselves.'
                  }
                >
                  <Button
                    variant="ghost"
                    disabled={busy}
                    className={cn(OUTCOME_BTN, priority && 'border border-amber-500/50 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400')}
                    onClick={() => void togglePriority(r)}
                  >
                    <FlameKindling className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden />
                    {priority ? 'Remove priority' : 'Mark priority'}
                  </Button>
                </Hint>
              )}
              {open && !r.not_on_whatsapp && (
                <Hint text="Stop calling this lead. Automatic WhatsApp messages will follow up instead.">
                  <Button variant="ghost" disabled={busy} className={OUTCOME_BTN} onClick={() => void backToNurture(r)}>
                    <Repeat className="h-4 w-4" aria-hidden />
                    {t('backToNurture')}
                  </Button>
                </Hint>
              )}
              {canManageMembers && (
                <Hint text="Permanently removes this request (moves to Trash — admins only).">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    className={cn(OUTCOME_BTN, 'ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive')}
                    onClick={() => void remove(r)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                    Delete
                  </Button>
                </Hint>
              )}
            </div>
          )}
        </div>
      </article>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
            <PageGuide module="callbacks" />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canManageMembers && <TrashButton kind="callback" onRestored={() => void load()} />}
          <Hint text="Reload the latest requests from the server.">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              {t('refresh')}
            </Button>
          </Hint>
        </div>
      </div>

      {/* Tabs: callback requests · numbers not on WhatsApp (call them for their WhatsApp number) */}
      <div role="tablist" className="flex gap-1 overflow-x-auto rounded-xl bg-muted/50 p-1">
        {([
          { id: 'requests' as const, label: 'Callback requests', icon: PhoneCall, count: null as number | null, hint: 'People who asked us to call them.' },
          { id: 'nowa' as const, label: 'Not on WhatsApp', icon: PhoneOff, count: nowaCount, hint: 'Our WhatsApp messages cannot reach these numbers. Call them and ask for their WhatsApp number.' },
        ]).map((v) => (
          <Hint key={v.id} text={v.hint}>
            <button
              type="button"
              role="tab"
              aria-selected={view === v.id}
              onClick={() => setView(v.id)}
              className={cn(
                'inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none',
                view === v.id ? 'bg-background text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
              )}
            >
              <v.icon className="h-4 w-4" aria-hidden />
              {v.label}
              {!!v.count && (
                <span className="rounded-full bg-rose-500 px-1.5 text-xs leading-5 font-semibold text-white tabular-nums">{v.count}</span>
              )}
            </button>
          </Hint>
        ))}
      </div>

      {view === 'nowa' ? (
        <NotOnWhatsappPanel onCount={setNowaCount} />
      ) : (
      <>
      {/* Headline numbers (+ 14-day trend for owners/admins) */}
      <div className={cn('grid gap-3', canManageMembers ? 'sm:grid-cols-3 lg:grid-cols-[1fr_1fr_1fr_1.4fr]' : 'grid-cols-3')}>
        {[
          { label: t('statWaiting'), value: data?.stats.open, icon: Clock, tone: 'text-amber-600 bg-amber-500/15 dark:text-amber-400' },
          { label: t('statToday'), value: data?.stats.today, icon: PhoneCall, tone: 'text-primary bg-primary/15' },
          { label: t('statHandledToday'), value: data?.stats.handled_today, icon: CheckCircle2, tone: 'text-emerald-600 bg-emerald-500/15 dark:text-emerald-400' },
        ].map((s) => (
          <div key={s.label} className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3.5">
            <span className={cn('hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl sm:flex', s.tone)} aria-hidden>
              <s.icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-2xl leading-tight font-bold tabular-nums text-foreground">{s.value ?? '—'}</p>
              <p className="text-xs leading-snug text-muted-foreground">{s.label}</p>
            </div>
          </div>
        ))}
        {canManageMembers && (
        <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 sm:col-span-3 lg:col-span-1">
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
        )}
      </div>

      {/* Toolbar: search · who to show · when */}
      <div className="space-y-3 rounded-2xl border border-border bg-card p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="h-11 rounded-xl pr-10 pl-10 text-base sm:text-sm"
          />
          {query && (
            <Hint text="Clear the search box.">
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('clearSearch')}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
              >
                <X className="h-4 w-4" />
              </button>
            </Hint>
          )}
        </div>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          {([
            { items: STATUS_FILTERS, value: statusFilter, set: setStatusFilter, key: 'filter' as const, label: 'Show', hints: FILTER_HINT },
            { items: DAY_FILTERS, value: dayFilter, set: setDayFilter, key: 'day' as const, label: 'When', hints: DAY_HINT },
          ]).map((g) => (
            <div key={g.key} className="flex min-w-0 items-center gap-2">
              <span className="w-11 shrink-0 text-xs font-medium text-muted-foreground lg:w-auto">{g.label}</span>
              <div role="group" aria-label={g.label} className="flex min-w-0 gap-1 overflow-x-auto rounded-xl bg-muted/50 p-1">
                {g.items.map((f) => (
                  <Hint key={f} text={(g.hints as Record<string, string>)[f]}>
                    <button
                      type="button"
                      aria-pressed={g.value === f}
                      onClick={() => (g.set as (v: string) => void)(f)}
                      className={cn(
                        'inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none',
                        g.value === f ? 'bg-background text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
                      )}
                    >
                      {loading && g.value === f && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                      {t(`${g.key}.${f}`)}
                      {f === 'priority' && (data?.stats.priority ?? 0) > 0 && (
                        <span className="rounded-full bg-amber-500 px-1.5 text-xs leading-5 font-semibold text-white tabular-nums">
                          {data?.stats.priority}
                        </span>
                      )}
                    </button>
                  </Hint>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Call next + list */}
      {data === null || (loading && data.requests.length === 0) ? (
        <div className="flex h-48 items-center justify-center" role="status" aria-label={t('loading')}>
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : data.requests.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <PartyPopper className="h-7 w-7" aria-hidden />
          </span>
          <p className="mt-3 text-lg font-semibold text-foreground">{search ? t('noResults') : t('emptyTitle')}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t('emptyHint')}</p>
        </div>
      ) : (
        <div className={cn('relative space-y-5 transition-opacity', loading && 'pointer-events-none opacity-60')} aria-busy={loading}>
          {loading && (
            <div className="absolute inset-x-0 top-2 z-10 flex justify-center">
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-popover px-3 py-1 text-xs text-muted-foreground shadow-md">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
                {t('loading')}
              </span>
            </div>
          )}
          {nextUp && (
            <section aria-labelledby="call-next">
              <h2 id="call-next" className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                <span className="relative flex h-2.5 w-2.5" aria-hidden>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
                </span>
                Call next
              </h2>
              {renderCard(nextUp, true)}
            </section>
          )}
          {rest.length > 0 && (
            <section aria-labelledby="call-list">
              <h2 id="call-list" className="mb-2 text-sm font-semibold text-foreground">
                {nextUp ? 'After that' : t(`filter.${statusFilter}`)}{' '}
                <span className="font-normal text-muted-foreground">({restTotal})</span>
              </h2>
              <ul className="space-y-3">{rest.slice(0, visibleN).map((r) => <li key={r.id}>{renderCard(r, false)}</li>)}</ul>
              {restTotal > visibleN && (
                <div className="mt-4 flex justify-center">
                  <Hint text={`Load the next ${Math.min(PAGE_SIZE, restTotal - visibleN)} requests.`}>
                    <Button
                      variant="outline"
                      className="h-11 rounded-xl px-6"
                      disabled={loadingMore}
                      onClick={() => {
                        // Out of loaded rows → fetch the next page from the server first.
                        if (visibleN + PAGE_SIZE > rest.length && rest.length < restTotal) void loadMore();
                        setPage({ key: filterKey, n: visibleN + PAGE_SIZE });
                      }}
                    >
                      {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : `Show more (${restTotal - visibleN} left)`}
                    </Button>
                  </Hint>
                </div>
              )}
            </section>
          )}
        </div>
      )}
      </>
      )}
      {(() => {
        const open = data?.requests.find((x) => x.id === detailsId) ?? null;
        return (
          <CallbackDetailsSheet
            id={detailsId}
            refreshKey={detailsKey}
            canAct={canSendMessages}
            busy={!!open && busyId === open.id}
            onClose={() => setDetailsId(null)}
            onNote={() => open && editNote(open)}
            onReopen={() => open && void update(open, { status: 'new' }, t('reopened'))}
            onPaymentLink={() => open && void sendPaymentLink(open)}
          />
        );
      })()}
      {noteFor && (
        <CallbackNoteDialog
          key={noteFor.id}
          open
          name={noteFor.contact_name || noteFor.contact_phone || t('unknown')}
          phone={noteFor.contact_phone}
          initial={noteFor.note ?? ''}
          onClose={() => setNoteFor(null)}
          onSave={(note) => update(noteFor, { note }, t('noteSaved'))}
        />
      )}
    </div>
  );
}
