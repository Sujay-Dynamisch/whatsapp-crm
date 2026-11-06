'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CalendarClock, CheckCircle2, CircleStop, GitBranch, Loader2, MessageCircleReply, SkipForward, Send, Undo2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { slotsFor, type JourneyGraph, type JourneyNode, type NodeConfigs } from '@/lib/journeys/graph';

const SEND_TYPES = new Set(['send_template', 'send_text', 'send_media', 'send_buttons']);
/** Steps whose path depends on the contact or data — the plan stops there. */
const BRANCH_TYPES = new Set(['condition', 'switch', 'wait_for_reply', 'loop']);

interface PlanRun {
  id: string;
  status: 'active' | 'waiting' | 'completed' | 'exited' | 'failed';
  current_node_id: string | null;
  next_run_at: string | null;
  context: Record<string, unknown>;
}

interface Upcoming {
  node: JourneyNode;
  /** A timed wait sits between the previous item and this one. */
  afterWait: JourneyNode | null;
}

function label(node: JourneyNode, t: ReturnType<typeof useTranslations>): string {
  return node.label?.trim() || t(`node.${node.type}`);
}

/** The node a step continues to when nothing has to be decided. */
function straightNext(node: JourneyNode): string | undefined {
  const slots = slotsFor(node);
  const slot = slots.includes('next') ? 'next' : slots.includes('success') ? 'success' : undefined;
  return slot ? node.next?.[slot] : undefined;
}

/**
 * Messages this run will send next, following the graph from where it
 * waits until the path depends on the contact (reply, condition, loop)
 * or ends. Waiting for a reply: the "no reply" path is shown.
 */
export function planUpcoming(graph: JourneyGraph, current: JourneyNode | undefined) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const items: Upcoming[] = [];
  let branch: JourneyNode | null = null;
  let ends = false;
  if (!current) return { items, branch, ends };

  let id = current.type === 'wait_for_reply' ? current.next?.timeout : straightNext(current);
  let pendingWait: JourneyNode | null = null;
  for (let i = 0; id && i < 40; i++) {
    const node = byId.get(id);
    if (!node) break;
    if (node.type === 'end') {
      ends = true;
      break;
    }
    if (BRANCH_TYPES.has(node.type)) {
      branch = node;
      break;
    }
    if (SEND_TYPES.has(node.type)) {
      items.push({ node, afterWait: pendingWait });
      pendingWait = null;
      if (items.length >= 6) break;
    } else if (node.type === 'wait') {
      pendingWait = node;
    }
    id = straightNext(node);
    if (!id) ends = true;
  }
  return { items, branch, ends };
}

export function RunPlan({
  journeyId,
  graph,
  run,
  sentCount,
  canControl,
  onChanged,
}: {
  journeyId: string;
  graph: JourneyGraph;
  run: PlanRun;
  sentCount: number;
  canControl: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations('Journeys');
  const [busy, setBusy] = useState<string | null>(null);
  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const current = run.current_node_id ? byId.get(run.current_node_id) : undefined;
  const waiting = run.status === 'waiting';
  const waitingForReply = waiting && current?.type === 'wait_for_reply';
  const plan = waiting ? planUpcoming(graph, current) : { items: [], branch: null, ends: false };
  const skipped = new Set(((run.context?.skip_nodes as string[] | undefined) ?? []).filter(Boolean));
  const first = plan.items.find((u) => !skipped.has(u.node.id));
  // The next message goes out when the current wait ends, unless another wait sits in between.
  const firstAt = first && !first.afterWait && plan.items.indexOf(first) === 0 ? run.next_run_at : null;

  async function control(body: Record<string, unknown>, key: string, ok: string) {
    setBusy(key);
    try {
      const res = await fetch(`/api/journeys/${journeyId}/runs/${run.id}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t('runs.plan.failed'));
        return;
      }
      toast.success(ok);
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  // Headline: one sentence a non-technical teammate can act on.
  let headline: { icon: typeof Send; tone: string; text: string };
  if (!waiting) {
    headline =
      run.status === 'completed'
        ? { icon: CheckCircle2, tone: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10', text: t('runs.plan.finished') }
        : run.status === 'active'
          ? { icon: Loader2, tone: 'text-sky-600 dark:text-sky-400 bg-sky-500/10', text: t('runs.plan.working') }
          : { icon: CircleStop, tone: 'text-muted-foreground bg-muted', text: t('runs.plan.stopped') };
  } else if (waitingForReply) {
    headline = {
      icon: MessageCircleReply,
      tone: 'text-sky-600 dark:text-sky-400 bg-sky-500/10',
      text: run.next_run_at ? t('runs.plan.waitingReplyUntil', { when: when(run.next_run_at) }) : t('runs.plan.waitingReply'),
    };
  } else if (first) {
    headline = {
      icon: CalendarClock,
      tone: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
      text: firstAt
        ? t('runs.plan.nextAt', { name: label(first.node, t), when: when(firstAt) })
        : t('runs.plan.nextLater', { name: label(first.node, t) }),
    };
  } else {
    headline = { icon: CalendarClock, tone: 'text-amber-600 dark:text-amber-400 bg-amber-500/10', text: t('runs.plan.noMoreMessages') };
  }

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-start gap-3">
        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', headline.tone)}>
          <headline.icon className={cn('h-4 w-4', run.status === 'active' && 'animate-spin')} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{headline.text}</p>
          <p className="text-xs text-muted-foreground">{t('runs.plan.sentSoFar', { count: sentCount })}</p>
        </div>
        {canControl && waiting && (first || waitingForReply) && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              void control(
                { action: 'send_now' },
                'now',
                waitingForReply ? t('runs.plan.continuedNow') : t('runs.plan.sendingNow')
              )
            }
          >
            {busy === 'now' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {waitingForReply ? t('runs.plan.dontWait') : t('runs.plan.sendNow')}
          </Button>
        )}
      </div>

      {waiting && plan.items.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            {waitingForReply ? t('runs.plan.ifNoReply') : t('runs.plan.comingUp')}
          </p>
          <ol className="space-y-1.5">
            {plan.items.map((u, i) => {
              const isSkipped = skipped.has(u.node.id);
              const tpl = u.node.type === 'send_template' ? (u.node.config as NodeConfigs['send_template']).template_name : null;
              return (
                <li
                  key={`${u.node.id}-${i}`}
                  className={cn('flex items-center gap-3 rounded-lg border border-border px-3 py-2', isSkipped && 'border-dashed opacity-60')}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-foreground">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={cn('truncate text-sm text-foreground', isSkipped && 'line-through')}>{label(u.node, t)}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {isSkipped
                        ? t('runs.plan.willSkip')
                        : i === 0 && firstAt
                          ? when(firstAt)
                          : u.afterWait
                            ? t('runs.plan.after', { wait: label(u.afterWait, t) })
                            : t('runs.plan.rightAfter')}
                      {tpl ? ` · ${tpl}` : ''}
                    </p>
                  </div>
                  {canControl && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0 text-xs"
                      disabled={busy !== null}
                      onClick={() =>
                        void control(
                          { action: 'skip', node_id: u.node.id, skip: !isSkipped },
                          u.node.id,
                          isSkipped ? t('runs.plan.unskipped', { name: label(u.node, t) }) : t('runs.plan.skippedToast', { name: label(u.node, t) })
                        )
                      }
                    >
                      {busy === u.node.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : isSkipped ? (
                        <Undo2 className="h-3.5 w-3.5" />
                      ) : (
                        <SkipForward className="h-3.5 w-3.5" />
                      )}
                      {isSkipped ? t('runs.plan.undoSkip') : t('runs.plan.skip')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {waiting && (plan.branch || plan.ends) && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          {plan.branch ? t('runs.plan.thenDepends', { step: label(plan.branch, t) }) : t('runs.plan.thenEnds')}
        </p>
      )}
    </section>
  );
}
