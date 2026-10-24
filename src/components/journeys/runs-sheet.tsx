'use client';
import { confirmDialog } from '@/components/ui/confirm-dialog';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight, CircleStop, Loader2, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { JourneyGraph, JourneyNode, NodeConfigs } from '@/lib/journeys/graph';
import { NODE_ACCENT, NODE_ICON } from './node-meta';

interface RunRow {
  id: string;
  status: 'active' | 'waiting' | 'completed' | 'exited' | 'failed';
  current_node_id: string | null;
  steps_taken: number;
  last_error: string | null;
  entered_at: string;
  completed_at: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  messages?: Record<MessageStatus, number> | null;
}

type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed';

/** One message the run sent (journey_messages, migration 056). */
interface RunMessage {
  id: string;
  node_id: string;
  kind: 'template' | 'text' | 'media' | 'buttons' | 'retry' | 'fallback';
  template_name: string | null;
  content_text: string | null;
  status: MessageStatus;
  error_code: number | null;
  error_title: string | null;
  error_details: string | null;
  attempt: number;
  next_retry_at: string | null;
  resolved: 'retried' | 'fallback_sent' | 'expired' | 'superseded' | 'opted_out' | null;
  created_at: string;
}

const MESSAGE_STATUS_CLASS: Record<MessageStatus, string> = {
  sent: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  delivered: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  read: 'border-emerald-600/50 bg-emerald-600/15 text-emerald-700 dark:text-emerald-300',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
};

interface RunEvent {
  id: number;
  node_id: string;
  event: string;
  detail: string | null;
  data: unknown;
  created_at: string;
}

interface RunDetail {
  run: RunRow & { context: Record<string, unknown>; next_run_at: string | null };
  events: RunEvent[];
  messages?: RunMessage[];
}

const STATUS_CLASS: Record<RunRow['status'], string> = {
  active: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  waiting: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  completed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  exited: 'border-border bg-muted text-muted-foreground',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
};

const FILTERS = ['all', 'failed', 'waiting', 'completed'] as const;

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-snug">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

type Translate = ReturnType<typeof useTranslations>;

const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** "webinar_link" → "Webinar link", "msg3_iso" → "Msg3 time", "added_ist" → "Added (IST)". */
function humanKey(key: string): string {
  const k = key
    .replace(/_iso$/, ' time')
    .replace(/_ist$/, ' (IST)')
    .replace(/_text$/, '')
    .replace(/_id$/, ' ID')
    .replace(/[_-]+/g, ' ')
    .trim();
  return k.charAt(0).toUpperCase() + k.slice(1);
}

function scalar(v: unknown, t: Translate): string {
  if (v === null || v === undefined || v === '') return t('runs.none');
  if (typeof v === 'boolean') return v ? t('runs.yes') : t('runs.no');
  if (typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v))) return when(v);
  return String(v);
}

/** Step data / variables as labelled rows instead of JSON. */
function Readable({ value, t }: { value: unknown; t: Translate }) {
  if (Array.isArray(value)) {
    if (value.every((x) => x === null || typeof x !== 'object')) {
      return <span className="break-words">{value.length ? value.map((x) => scalar(x, t)).join(', ') : t('runs.none')}</span>;
    }
    return (
      <div className="space-y-1">
        {value.map((x, i) => (
          <div key={i} className="rounded-md bg-muted/40 p-1.5">
            <Readable value={x} t={t} />
          </div>
        ))}
      </div>
    );
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return <span>{t('runs.none')}</span>;
    return (
      <dl className="grid grid-cols-[minmax(6rem,max-content)_1fr] gap-x-3 gap-y-1">
        {entries.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-muted-foreground">{humanKey(k)}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words">
              {v !== null && typeof v === 'object' ? <Readable value={v} t={t} /> : scalar(v, t)}
            </dd>
          </Fragment>
        ))}
      </dl>
    );
  }
  return <span className="whitespace-pre-wrap break-words">{scalar(value, t)}</span>;
}

/** Readable view with the raw JSON one click away. */
function DataView({ value, t }: { value: unknown; t: Translate }) {
  return (
    <div className="space-y-1.5 text-xs">
      <Readable value={value} t={t} />
      <details>
        <summary className="cursor-pointer text-[11px] text-muted-foreground">{t('runs.raw')}</summary>
        <div className="mt-1">
          <Json value={value} />
        </div>
      </details>
    </div>
  );
}

/** A slot name ("next", "case_2", "timeout") as words. */
function outcomeLabel(node: JourneyNode | undefined, slot: string, t: Translate): string {
  if (slot.startsWith('case_')) {
    const i = Number(slot.slice(5));
    const label = node?.type === 'switch' ? (node.config as NodeConfigs['switch']).cases?.[i]?.label?.trim() : '';
    return label || t('runs.outcome.option', { n: i + 1 });
  }
  switch (slot) {
    case 'next':
      return node?.type === 'wait' ? t('runs.outcome.waitDone') : t('runs.outcome.done');
    case 'success':
      return t('runs.outcome.done');
    case 'error':
      return t('runs.outcome.error');
    case 'yes':
      return t('runs.outcome.yes');
    case 'no':
      return t('runs.outcome.no');
    case 'replied':
      return t('runs.outcome.replied');
    case 'timeout':
      return t('runs.outcome.timeout');
    case 'each':
      return t('runs.outcome.each');
    case 'done':
      return t('runs.outcome.loopDone');
    case 'default':
      return t('runs.outcome.noMatch');
  }
  return slot;
}

/** One step's events folded into a row: entered → left by slot / failed. */
interface StepRow {
  nodeId: string;
  at: string;
  outcome: string | null;
  failed: boolean;
  /** Message not sent (the run carried on). */
  warn?: boolean;
  /** The run was stopped here (opt-out / exit tag). */
  stopped?: boolean;
  detail: string | null;
  data: unknown;
  logs: string | null;
}

function foldEvents(events: RunEvent[]): StepRow[] {
  const rows: StepRow[] = [];
  for (const e of events) {
    if (e.event === 'entered') {
      rows.push({ nodeId: e.node_id, at: e.created_at, outcome: null, failed: false, detail: null, data: undefined, logs: null });
      continue;
    }
    // Resuming from a wait logs an exit without a fresh "entered".
    let row = [...rows].reverse().find((r) => r.nodeId === e.node_id && r.outcome === null && !r.failed);
    if (!row) {
      row = { nodeId: e.node_id, at: e.created_at, outcome: null, failed: false, detail: null, data: undefined, logs: null };
      rows.push(row);
    }
    if (e.event === 'log') row.logs = e.detail;
    else if (e.event === 'send_failed') {
      row.warn = true;
      row.detail = e.detail;
    } else if (e.event === 'exited') {
      row.stopped = true;
      row.detail = e.detail;
    }
    else if (e.event === 'failed') {
      row.failed = true;
      row.detail = e.detail;
      if (e.data !== null && e.data !== undefined) row.data = e.data;
    } else if (e.event.startsWith('exit:')) {
      row.outcome = e.event.slice(5);
      if (e.data !== null && e.data !== undefined) row.data = e.data;
    }
  }
  return rows;
}

export function RunsSheet({
  journeyId,
  graph,
  open,
  onOpenChange,
}: {
  journeyId: string;
  graph: JourneyGraph;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('Journeys');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [openStep, setOpenStep] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = filter === 'all' ? '' : `?status=${filter}`;
      const res = await fetch(`/api/journeys/${journeyId}/runs${qs}`);
      const data = await res.json().catch(() => ({}));
      setRuns(res.ok ? data.runs : []);
    } finally {
      setLoading(false);
    }
  }, [journeyId, filter]);

  useEffect(() => {
    if (open && !detail) void load();
  }, [open, load, detail]);

  /** Row being opened — shows its spinner and blocks double clicks. */
  const [openingId, setOpeningId] = useState<string | null>(null);

  async function openRun(id: string) {
    setLoading(true);
    setOpeningId(id);
    setOpenStep(null);
    try {
      const res = await fetch(`/api/journeys/${journeyId}/runs/${id}`);
      if (res.ok) setDetail(await res.json());
      else toast.error(t('runs.loadFailed'));
    } catch {
      toast.error(t('runs.loadFailed'));
    } finally {
      setLoading(false);
      setOpeningId(null);
    }
  }

  const [stopping, setStopping] = useState(false);

  /** Stop this contact's run (waiting runs only — the server re-checks). */
  async function stopRun() {
    if (!detail) return;
    const who = detail.run.contact_name || detail.run.contact_phone || t('runs.run');
    if (!(await confirmDialog({ title: t('runs.stopConfirm', { name: who }), destructive: true, confirmLabel: t('runs.stop') }))) return;
    setStopping(true);
    try {
      const res = await fetch(`/api/journeys/${journeyId}/runs/${detail.run.id}/stop`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t('runs.stopFailed'));
        return;
      }
      toast.success(t('runs.stopped', { name: who }));
      await openRun(detail.run.id);
      setRuns(null);
    } finally {
      setStopping(false);
    }
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const steps = detail ? foldEvents(detail.events) : [];
  const ctx = (detail?.run.context ?? {}) as { vars?: Record<string, unknown>; trigger_data?: unknown };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{detail ? detail.run.contact_name || detail.run.contact_phone || t('runs.run') : t('runs.title')}</SheetTitle>
          <SheetDescription>{detail ? when(detail.run.entered_at) : t('runs.help')}</SheetDescription>
        </SheetHeader>

        <div className="space-y-3 px-4 pb-6">
          {!detail ? (
            <>
              <div className="flex items-center gap-1.5">
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-xs font-medium',
                      filter === f ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground'
                    )}
                  >
                    {t(`runs.filter.${f}`)}
                  </button>
                ))}
                <Button variant="ghost" size="icon" className="ml-auto h-8 w-8" onClick={load} disabled={loading} aria-label={t('runs.refresh')}>
                  <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                </Button>
              </div>
              {runs === null ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : runs.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">{t('runs.empty')}</p>
              ) : (
                <ul
                  aria-busy={loading}
                  className={cn('divide-y divide-border rounded-lg border border-border transition-opacity', loading && !openingId && 'opacity-60')}
                >
                  {runs.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => openRun(r.id)}
                        disabled={openingId !== null}
                        className={cn(
                          'flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/50 disabled:cursor-wait',
                          openingId === r.id && 'bg-muted/50'
                        )}
                      >
                        <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium', STATUS_CLASS[r.status])}>
                          {t(`runs.status.${r.status}`)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{r.contact_name || r.contact_phone || '—'}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {when(r.entered_at)} · {t('runs.steps', { count: r.steps_taken })}
                            {r.last_error ? ` · ${r.last_error}` : ''}
                          </span>
                          {r.messages && (
                            <span className="mt-1 flex flex-wrap gap-1">
                              {(['sent', 'delivered', 'read', 'failed'] as const)
                                .filter((k) => r.messages![k] > 0)
                                .map((k) => (
                                  <span key={k} className={cn('rounded-full border px-1.5 py-px text-[10px] font-medium', MESSAGE_STATUS_CLASS[k])}>
                                    {t(`runs.messages.count.${k}`, { count: r.messages![k] })}
                                  </span>
                                ))}
                            </span>
                          )}
                        </span>
                        {openingId === r.id ? (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setDetail(null)}>
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {t('runs.back')}
                </Button>
                <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', STATUS_CLASS[detail.run.status])}>
                  {t(`runs.status.${detail.run.status}`)}
                </span>
                {detail.run.status === 'waiting' && detail.run.next_run_at && (
                  <span className="text-xs text-muted-foreground">{t('runs.until', { when: when(detail.run.next_run_at) })}</span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto h-8 w-8"
                  onClick={() => openRun(detail.run.id)}
                  disabled={loading || stopping}
                  aria-label={t('runs.refresh')}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                </Button>
                {(detail.run.status === 'waiting' || detail.run.status === 'active') && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={stopRun}
                    disabled={stopping}
                  >
                    {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CircleStop className="h-3.5 w-3.5" />}
                    {t('runs.stop')}
                  </Button>
                )}
              </div>
              {detail.run.last_error && (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{detail.run.last_error}</p>
              )}

              {detail.messages && detail.messages.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">{t('runs.messages.title')}</p>
                  <ol className="space-y-1.5">
                    {detail.messages.map((m) => {
                      const node = byId.get(m.node_id);
                      return (
                        <li key={m.id} className="space-y-1 rounded-lg border border-border p-2.5">
                          <div className="flex items-center gap-2">
                            <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium', MESSAGE_STATUS_CLASS[m.status])}>
                              {t(`runs.messages.status.${m.status}`)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm">{node?.label?.trim() || m.template_name || m.node_id}</span>
                            <span className="shrink-0 text-[11px] text-muted-foreground">{when(m.created_at)}</span>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {t(`runs.messages.kind.${m.kind}`)}
                            {m.template_name ? ` · ${m.template_name}` : ''}
                            {m.attempt > 1 ? ` · ${t('runs.messages.attempt', { n: m.attempt })}` : ''}
                          </p>
                          {m.status === 'failed' && (
                            <p className="text-xs text-destructive">
                              {m.error_code ? `[${m.error_code}] ` : ''}
                              {m.error_title}
                              {m.error_details ? ` — ${m.error_details}` : ''}
                            </p>
                          )}
                          {m.resolved ? (
                            <p className="text-[11px] text-muted-foreground">{t(`runs.messages.resolved.${m.resolved}`)}</p>
                          ) : m.status === 'failed' && m.next_retry_at ? (
                            <p className="text-[11px] text-amber-600 dark:text-amber-400">{t('runs.messages.retryAt', { when: when(m.next_retry_at) })}</p>
                          ) : m.status === 'failed' && m.content_text ? (
                            <p className="text-[11px] text-amber-600 dark:text-amber-400">{t('runs.messages.awaitingReply')}</p>
                          ) : null}
                          {m.content_text && (
                            <details>
                              <summary className="cursor-pointer text-[11px] text-muted-foreground">{t('runs.messages.content')}</summary>
                              <pre className="mt-1 whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-[11px] leading-snug">{m.content_text}</pre>
                            </details>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </div>
              )}

              <ol className="space-y-1.5">
                {steps.map((s, i) => {
                  const node = byId.get(s.nodeId);
                  const Icon = node ? NODE_ICON[node.type] : ChevronRight;
                  const expandable = s.data !== undefined || s.logs || s.detail;
                  return (
                    <li key={i} className="rounded-lg border border-border">
                      <button
                        type="button"
                        disabled={!expandable}
                        onClick={() => setOpenStep(openStep === i ? null : i)}
                        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
                      >
                        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md border', node ? NODE_ACCENT[node.type] : '')}>
                          <Icon className="size-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{node ? node.label?.trim() || t(`node.${node.type}`) : s.nodeId}</span>
                          <span className="block text-[11px] text-muted-foreground">{when(s.at)}</span>
                        </span>
                        {s.failed ? (
                          <span className="shrink-0 text-xs font-medium text-destructive">{t('runs.failed')}</span>
                        ) : s.stopped ? (
                          <span className="shrink-0 text-xs font-medium text-muted-foreground">{t('runs.outcome.stopped')}</span>
                        ) : s.warn ? (
                          <span className="shrink-0 text-xs font-medium text-amber-600 dark:text-amber-400">{t('runs.outcome.sendFailed')}</span>
                        ) : s.outcome ? (
                          <span className="shrink-0 text-xs text-muted-foreground">→ {outcomeLabel(node, s.outcome, t)}</span>
                        ) : (
                          <span className="shrink-0 text-xs text-amber-600 dark:text-amber-400">
                            {detail.run.status === 'waiting' && detail.run.next_run_at && i === steps.length - 1
                              ? t('runs.until', { when: when(detail.run.next_run_at) })
                              : t('runs.inProgress')}
                          </span>
                        )}
                        {expandable && (
                          <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', openStep === i && 'rotate-90')} />
                        )}
                      </button>
                      {openStep === i && (
                        <div className="space-y-2 border-t border-border p-2.5">
                          {s.detail && (
                            <p className={cn('text-xs', s.failed ? 'text-destructive' : 'text-amber-600 dark:text-amber-400')}>{s.detail}</p>
                          )}
                          {s.data !== undefined && <DataView value={s.data} t={t} />}
                          {s.logs && <pre className="whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-mono text-[11px]">{s.logs}</pre>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>

              {ctx.vars && Object.keys(ctx.vars).length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium">{t('runs.variables')}</p>
                  <div className="rounded-lg border border-border p-2.5">
                    <DataView value={ctx.vars} t={t} />
                  </div>
                </div>
              )}
              {ctx.trigger_data !== undefined && (
                <div className="space-y-1">
                  <p className="text-xs font-medium">{t('runs.triggerData')}</p>
                  <div className="rounded-lg border border-border p-2.5">
                    <DataView value={ctx.trigger_data} t={t} />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
