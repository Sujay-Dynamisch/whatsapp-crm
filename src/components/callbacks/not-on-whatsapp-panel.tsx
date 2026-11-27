'use client';

// ============================================================
// Callbacks → "Not on WhatsApp" tab — leads whose WhatsApp messages can never arrive
// (Meta 131026; src/lib/contacts/not-on-whatsapp.ts). Their journey is
// stopped. The caller phones them, asks for their WhatsApp number, saves it
// and picks where the WhatsApp messages start again. Callers see only
// their own leads.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Phone, RefreshCw, Search, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useIncrementalList } from '@/hooks/use-incremental-list';

interface Lead {
  contact_id: string;
  name: string | null;
  phone: string;
  caller_name: string | null;
  failed: number;
  marked_at: string | null;
}
interface Step {
  id: string;
  label: string;
  hint: string;
}

const SELECT =
  'h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

const fmt = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(iso))
    : '';

export function NotOnWhatsappPanel({
  onCount,
}: {
  onCount?: (n: number) => void;
}) {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/not-on-whatsapp');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || 'Could not load the list');
        return;
      }
      setLeads(json.leads ?? []);
      onCount?.((json.leads ?? []).length);
      setSteps(json.steps ?? []);
    } finally {
      setLoading(false);
    }
  }, [onCount]);
  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return leads ?? [];
    return (leads ?? []).filter(
      (l) => (l.name ?? '').toLowerCase().includes(q) || l.phone.includes(q)
    );
  }, [leads, query]);
  const { visible, hasMore, sentinelRef } = useIncrementalList(filtered, {
    step: 30,
    resetKey: query,
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-muted-foreground max-w-2xl text-sm">
            Our WhatsApp messages can&apos;t reach these leads — the number has
            no WhatsApp. Their messages are paused.{' '}
            <strong className="text-foreground">
              Call them, ask for their WhatsApp number
            </strong>
            , save it below and choose where the messages should start.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />{' '}
          Refresh
        </Button>
      </div>

      <div className="relative">
        <Search
          className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or number"
          className="pl-9"
        />
      </div>

      {leads === null ? (
        <div className="flex justify-center py-16">
          <Loader2 className="text-primary h-6 w-6 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="border-border rounded-2xl border border-dashed p-10 text-center">
          <p className="text-foreground font-medium">
            {query
              ? 'No lead matches this search.'
              : 'Nobody here — every lead is reachable on WhatsApp. 🎉'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          <li className="text-muted-foreground list-none text-sm">
            {filtered.length} lead{filtered.length === 1 ? '' : 's'} to call
          </li>
          {visible.map((l) => (
            <LeadCard
              key={l.contact_id}
              lead={l}
              steps={steps}
              onDone={() =>
                setLeads((prev) => {
                  const next = (prev ?? []).filter(
                    (x) => x.contact_id !== l.contact_id
                  );
                  onCount?.(next.length);
                  return next;
                })
              }
            />
          ))}
          {hasMore && (
            <li ref={sentinelRef} className="h-8 list-none" aria-hidden />
          )}
        </ul>
      )}
    </div>
  );
}

function LeadCard({
  lead,
  steps,
  onDone,
}: {
  lead: Lead;
  steps: Step[];
  onDone: () => void;
}) {
  const [phone, setPhone] = useState(lead.phone);
  const [step, setStep] = useState(steps[0]?.id ?? 'start');
  const [busy, setBusy] = useState(false);
  const chosen = steps.find((s) => s.id === step);
  const name = lead.name || lead.phone;

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/not-on-whatsapp/${lead.contact_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: phone.trim() !== lead.phone ? phone : null,
          step,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || 'Could not save');
        return;
      }
      toast.success(
        `${name}: WhatsApp messages started — ${chosen?.label ?? ''}`
      );
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="border-border bg-card rounded-2xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-foreground truncate text-base font-semibold">
            {name}
          </p>
          <p className="text-foreground font-mono text-lg tracking-wide">
            {lead.phone}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {lead.failed} message{lead.failed === 1 ? '' : 's'} couldn&apos;t be
            delivered
            {lead.marked_at ? ` · since ${fmt(lead.marked_at)}` : ''}
            {lead.caller_name ? ` · Caller: ${lead.caller_name}` : ''}
          </p>
        </div>
        <a
          href={`tel:+${lead.phone.replace(/\D/g, '')}`}
          className="inline-flex h-11 items-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          <Phone className="h-4 w-4" aria-hidden /> Call{' '}
          {lead.name?.split(' ')[0] || 'now'}
        </a>
      </div>

      <div className="border-border mt-4 grid gap-3 border-t pt-4 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
        <label className="block space-y-1">
          <span className="text-muted-foreground block text-xs font-medium">
            Their WhatsApp number
          </span>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
            placeholder="e.g. 98765 43210"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-muted-foreground block text-xs font-medium">
            Start WhatsApp messages from
          </span>
          <select
            className={SELECT}
            value={step}
            onChange={(e) => setStep(e.target.value)}
          >
            {steps.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          className="h-10"
          disabled={busy || !phone.trim()}
          onClick={() => void save()}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}{' '}
          Save & start
        </Button>
      </div>
      {chosen && (
        <p className="text-muted-foreground mt-2 text-xs">{chosen.hint}</p>
      )}
    </li>
  );
}
