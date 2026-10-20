'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { JourneyGraph } from '@/lib/journeys/graph';
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
}

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

/** One step's events folded into a row: entered → left by slot / failed. */
interface StepRow {
  nodeId: string;
  at: string;
  outcome: string | null;
  failed: boolean;
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

  async function openRun(id: string) {
    setLoading(true);
    setOpenStep(null);
    try {
      const res = await fetch(`/api/journeys/${journeyId}/runs/${id}`);
      if (res.ok) setDetail(await res.json());
    } finally {
      setLoading(false);
    }
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const steps = detail ? foldEvents(detail.events) : [];
  const ctx = (detail?.run.context ?? {}) as { vars?: Record<string, unknown>; trigger_data?: unknown };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
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
                <Button variant="ghost" size="icon" className="ml-auto h-8 w-8" onClick={load} aria-label={t('runs.refresh')}>
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
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {runs.map((r) => (
                    <li key={r.id}>
                      <button type="button" onClick={() => openRun(r.id)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/50">
                        <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium', STATUS_CLASS[r.status])}>
                          {t(`runs.status.${r.status}`)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{r.contact_name || r.contact_phone || '—'}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {when(r.entered_at)} · {t('runs.steps', { count: r.steps_taken })}
                            {r.last_error ? ` · ${r.last_error}` : ''}
                          </span>
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
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
              </div>
              {detail.run.last_error && (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{detail.run.last_error}</p>
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
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {node ? node.label?.trim() || t(`node.${node.type}`) : s.nodeId}
                        </span>
                        {s.failed ? (
                          <span className="text-xs font-medium text-destructive">{t('runs.failed')}</span>
                        ) : s.outcome ? (
                          <span className="text-xs text-muted-foreground">→ {s.outcome}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">…</span>
                        )}
                        {expandable && (
                          <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', openStep === i && 'rotate-90')} />
                        )}
                      </button>
                      {openStep === i && (
                        <div className="space-y-2 border-t border-border p-2.5">
                          <p className="text-[11px] text-muted-foreground">
                            {when(s.at)} · <code>{s.nodeId}</code>
                          </p>
                          {s.detail && <p className="text-xs text-destructive">{s.detail}</p>}
                          {s.data !== undefined && <Json value={s.data} />}
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
                  <Json value={ctx.vars} />
                </div>
              )}
              {ctx.trigger_data !== undefined && (
                <div className="space-y-1">
                  <p className="text-xs font-medium">{t('runs.triggerData')}</p>
                  <Json value={ctx.trigger_data} />
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
