'use client';

// Full details of one callback request (migration 099): the lead, their
// tags, quick facts and one timeline — requests, status changes, notes
// and payment links — newest first. Opened by clicking a callback card.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { format, formatDistanceToNow } from 'date-fns';
import {
  CheckCircle2,
  Copy,
  CreditCard,
  Loader2,
  MessageSquare,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  RotateCcw,
  StickyNote,
} from 'lucide-react';
import { toast } from 'sonner';

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Status = 'new' | 'called' | 'no_answer' | 'done';

interface TimelineItem {
  at: string;
  kind: 'requested' | 'status' | 'note' | 'payment_link';
  value: string | null;
  detail: string | null;
  actor: string | null;
}

interface Details {
  request: {
    id: string;
    conversation_id: string | null;
    status: Status;
    source: string | null;
    requested_at: string;
    no_answer_count: number | null;
    priority: 'normal' | 'high' | null;
    source_kind: string | null;
    caller_name: string | null;
    ai_meta: { confidence?: number; requested_time?: string; language?: string } | null;
  };
  contact: { name: string | null; phone: string | null; email: string | null; created_at: string; owner_name: string | null } | null;
  tags: { name: string; color: string }[];
  requests: number;
  timeline: TimelineItem[];
  paymentLink: { available: boolean; windowOpen: boolean; templateOk: boolean; sentCount: number };
}

const STATUS_LABEL: Record<Status, string> = { new: 'New', called: 'Called', no_answer: 'No answer', done: 'Done' };
const STATUS_STYLE: Record<Status, string> = {
  new: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  called: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  no_answer: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400',
  done: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
};

const KIND_LABEL: Record<string, string> = {
  button: 'Tapped the callback button',
  whatsapp_button: 'Tapped the callback button',
  ai_inbox_text: 'Typed a callback request (found by AI)',
  ai_review: 'Possible request — AI was not sure',
  engagement: 'New lead to call',
};

function eventView(e: TimelineItem): { icon: typeof PhoneCall; tone: string; title: string } {
  if (e.kind === 'requested') return { icon: PhoneIncoming, tone: 'bg-violet-500/15 text-violet-600 dark:text-violet-400', title: 'Asked for a callback' };
  if (e.kind === 'note') return { icon: StickyNote, tone: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', title: 'Note added' };
  if (e.kind === 'payment_link')
    return {
      icon: CreditCard,
      tone: 'bg-primary/15 text-primary',
      title: e.value === 'template' ? 'Payment link sent (WhatsApp template)' : 'Payment link sent on WhatsApp',
    };
  switch (e.value) {
    case 'called':
      return { icon: PhoneCall, tone: 'bg-sky-500/15 text-sky-600 dark:text-sky-400', title: 'Marked as Called' };
    case 'no_answer':
      return { icon: PhoneMissed, tone: 'bg-rose-500/15 text-rose-600 dark:text-rose-400', title: 'No answer' };
    case 'done':
      return { icon: CheckCircle2, tone: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', title: 'Marked as Done' };
    default:
      return { icon: RotateCcw, tone: 'bg-muted text-muted-foreground', title: 'Re-opened' };
  }
}

export function CallbackDetailsSheet({
  id,
  refreshKey,
  canAct,
  busy,
  onClose,
  onNote,
  onReopen,
  onPaymentLink,
}: {
  id: string | null;
  refreshKey: number;
  canAct: boolean;
  busy: boolean;
  onClose: () => void;
  onNote: () => void;
  onReopen: () => void;
  onPaymentLink: () => void;
}) {
  const [data, setData] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    void (async () => {
      const res = await fetch(`/api/callbacks/${id}`);
      const json = await res.json().catch(() => ({}));
      if (!alive) return;
      if (!res.ok) setError(json?.error || 'Could not load details');
      else {
        setError(null);
        setData(json);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, refreshKey]);

  const r = data?.request.id === id ? data : null;
  const name = r?.contact?.name || r?.contact?.phone || 'Unknown';
  const phone = r?.contact?.phone ?? null;
  const pay = r?.paymentLink;

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        {!r ? (
          <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
            {error ?? <Loader2 className="h-6 w-6 animate-spin text-primary" />}
          </div>
        ) : (
          <>
            {/* Header */}
            <SheetHeader className="border-b border-border bg-gradient-to-br from-primary/10 via-transparent to-transparent p-5">
              <div className="flex items-start gap-3 pr-8">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-violet-500 text-base font-semibold text-white shadow-sm">
                  {name
                    .split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((w) => w[0]?.toUpperCase())
                    .join('') || <PhoneCall className="h-5 w-5" />}
                </div>
                <div className="min-w-0">
                  <SheetTitle className="truncate text-lg">{name}</SheetTitle>
                  <SheetDescription className="mt-0.5 flex items-center gap-1.5">
                    {phone ? (
                      <>
                        <a href={`tel:${phone}`} className="font-semibold tracking-wide text-foreground tabular-nums hover:text-primary">
                          {phone}
                        </a>
                        <button
                          type="button"
                          aria-label="Copy number"
                          className="rounded-md p-1 hover:bg-muted"
                          onClick={() => void navigator.clipboard.writeText(phone).then(() => toast.success('Number copied'))}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : (
                      'No phone number'
                    )}
                  </SheetDescription>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', STATUS_STYLE[r.request.status])}>
                      {STATUS_LABEL[r.request.status]}
                    </span>
                    {r.request.priority === 'high' && r.request.status !== 'done' && (
                      <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-semibold text-white">Priority</span>
                    )}
                  </div>
                </div>
              </div>
            </SheetHeader>

            <div className="space-y-5 p-5">
              {/* Actions */}
              <div className="flex flex-wrap gap-2">
                {phone && (
                  <a href={`tel:${phone}`} className={buttonVariants({ size: 'sm' })}>
                    <PhoneOutgoing className="h-3.5 w-3.5" /> Call
                  </a>
                )}
                {r.request.conversation_id && (
                  <Link href={`/inbox?c=${r.request.conversation_id}`} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                    <MessageSquare className="h-3.5 w-3.5" /> Open chat
                  </Link>
                )}
                {canAct && (
                  <>
                    <Button size="sm" variant="outline" disabled={busy || !pay?.available} onClick={onPaymentLink}>
                      <CreditCard className="h-3.5 w-3.5" /> Send payment link
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={onNote}>
                      <StickyNote className="h-3.5 w-3.5" /> Add note
                    </Button>
                    {r.request.status === 'done' && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={onReopen}>
                        <RotateCcw className="h-3.5 w-3.5" /> Reopen
                      </Button>
                    )}
                  </>
                )}
              </div>
              {canAct && pay && (
                <p className="-mt-3 text-[11px] text-muted-foreground">
                  {!pay.available
                    ? 'No payment link is set up yet (journey → Settings step).'
                    : pay.windowOpen
                      ? 'The lead messaged in the last 24 hours — the link goes as a normal WhatsApp message.'
                      : pay.templateOk
                        ? 'The lead has not messaged in 24 hours — the link goes through the approved "general update" template.'
                        : 'The lead has not messaged in 24 hours and the "general update" template is not approved — sending will fail.'}
                  {pay.sentCount > 0 && ` Already sent ${pay.sentCount} time${pay.sentCount === 1 ? '' : 's'} from here.`}
                </p>
              )}

              {/* Quick facts */}
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Asked', value: `${formatDistanceToNow(new Date(r.request.requested_at), { addSuffix: true })}`, sub: format(new Date(r.request.requested_at), 'd MMM, h:mm a') },
                  { label: 'Handled by', value: r.request.caller_name || r.contact?.owner_name || 'Not assigned', sub: r.contact?.owner_name ? 'Lead owner' : null },
                  { label: 'Calls not answered', value: String(r.request.no_answer_count ?? 0), sub: 'this request' },
                  { label: 'Callback requests', value: String(r.requests), sub: 'by this lead in total' },
                  { label: 'How they asked', value: KIND_LABEL[r.request.source_kind ?? 'button'] ?? 'Callback request', sub: r.request.ai_meta?.requested_time ? `Wants: ${r.request.ai_meta.requested_time}` : null },
                  { label: 'Lead since', value: r.contact ? format(new Date(r.contact.created_at), 'd MMM yyyy') : '—', sub: r.contact?.email ?? null },
                ].map((f) => (
                  <div key={f.label} className="rounded-xl border border-border bg-muted/30 px-3 py-2.5">
                    <p className="text-[11px] text-muted-foreground">{f.label}</p>
                    <p className="mt-0.5 truncate text-sm font-semibold text-foreground">{f.value}</p>
                    {f.sub && <p className="truncate text-[11px] text-muted-foreground">{f.sub}</p>}
                  </div>
                ))}
              </div>

              {r.request.source && (
                <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 px-3 py-2.5">
                  <p className="text-[11px] text-muted-foreground">They said</p>
                  <p className="mt-0.5 text-sm font-medium text-foreground">“{r.request.source}”</p>
                </div>
              )}

              {r.tags.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Tags</p>
                  <div className="flex flex-wrap gap-1.5">
                    {r.tags.map((t) => (
                      <span key={t.name} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-foreground">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t.color }} />
                        {t.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Timeline */}
              <div>
                <p className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Timeline</p>
                <ol className="relative space-y-4 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-border">
                  {r.timeline.map((e, i) => {
                    const v = eventView(e);
                    return (
                      <li key={`${e.at}-${i}`} className="relative flex gap-3">
                        <span className={cn('relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-popover', v.tone)}>
                          <v.icon className="h-3.5 w-3.5" />
                        </span>
                        <div className="min-w-0 flex-1 pt-1">
                          <p className="text-sm font-medium text-foreground">{v.title}</p>
                          {e.detail && e.kind === 'note' && (
                            <p className="mt-1 rounded-lg border border-amber-500/25 bg-amber-500/8 px-2.5 py-1.5 text-sm break-words text-foreground">{e.detail}</p>
                          )}
                          {e.detail && e.kind === 'requested' && <p className="mt-0.5 text-xs text-muted-foreground">“{e.detail}”</p>}
                          {e.detail && e.kind === 'payment_link' && <p className="mt-0.5 truncate text-xs text-muted-foreground">{e.detail}</p>}
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {e.actor ? `${e.actor} · ` : ''}
                            {format(new Date(e.at), 'd MMM, h:mm a')} · {formatDistanceToNow(new Date(e.at), { addSuffix: true })}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
