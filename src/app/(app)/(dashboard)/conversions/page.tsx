'use client';

import { useCallback, useEffect, useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { BadgeCheck, IndianRupee, Loader2, Pencil, Percent, RefreshCw, Search, Trash2, Trophy, UserRound, Users, X } from 'lucide-react';

import { PageGuide } from '@/components/guide/page-guide';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useIncrementalList } from '@/hooks/use-incremental-list';

type Range = 'month' | '30d' | 'all';
interface Conversion {
  id: string;
  contact_id: string;
  name: string | null;
  phone: string | null;
  caller_id: string | null;
  caller_name: string | null;
  amount: number | null;
  source: string;
  note: string | null;
  converted_at: string;
}
interface Data {
  isAdmin: boolean;
  currency: string;
  stats: { customers: number; this_month: number; revenue: number; leads: number; rate: number };
  byCaller: { caller_id: string | null; name: string; customers: number; revenue: number; leads: number; rate: number }[];
  callers: { id: string; name: string }[];
  conversions: Conversion[];
}

const RANGES: { key: Range; label: string }[] = [
  { key: 'month', label: 'This month' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'all', label: 'All time' },
];
const SOURCE_LABEL: Record<string, string> = {
  paid_tag: 'Paid',
  payment_record: 'Marked paid',
  installment: 'Instalment',
  manual: 'Manual',
  backfill: 'Earlier payment',
};

export default function ConversionsPage() {
  const [data, setData] = useState<Data | null>(null);
  // Draw rows as the user scrolls.
  const { visible: convRowsVisible, hasMore: convRowsMore, sentinelRef: convRowsSentinel } = useIncrementalList(data?.conversions ?? [], { step: 40 });
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<Range>('all');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Conversion | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ range });
      if (search) qs.set('q', search);
      const res = await fetch(`/api/conversions?${qs}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error === 'not_ready' ? 'Conversions are not set up yet — run migration 104.' : json?.error || 'Could not load conversions');
        return;
      }
      setData(json);
    } finally {
      setLoading(false);
    }
  }, [range, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const money = (n: number | null | undefined) =>
    n === null || n === undefined
      ? '—'
      : new Intl.NumberFormat('en-IN', { style: 'currency', currency: data?.currency || 'INR', maximumFractionDigits: 0 }).format(n);

  async function remove(c: Conversion) {
    const ok = await confirmDialog({
      title: `Remove ${c.name || c.phone || 'this lead'} from customers?`,
      description: 'They go back to being a lead and the "customer" tag is removed. Their payments are not touched.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/conversions/${c.id}`, { method: 'DELETE' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return void toast.error(json?.error || 'Could not remove');
    toast.success('Removed from customers');
    await load();
  }

  const s = data?.stats;
  const isAdmin = !!data?.isAdmin;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-foreground">Conversions</h1>
            <PageGuide module="conversions" />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {isAdmin ? 'Leads who paid and became customers — for the whole team.' : 'Your leads who paid and became customers.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
          Refresh
        </Button>
      </div>

      {/* Headline numbers */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: isAdmin ? 'Customers' : 'Your customers', value: s?.customers, icon: BadgeCheck, tone: 'text-emerald-600 bg-emerald-500/15 dark:text-emerald-400' },
          { label: 'This month', value: s?.this_month, icon: Trophy, tone: 'text-amber-600 bg-amber-500/15 dark:text-amber-400' },
          { label: 'Money received', value: s ? money(s.revenue) : undefined, icon: IndianRupee, tone: 'text-primary bg-primary/15' },
          { label: `Conversion rate (of ${s?.leads ?? 0} leads)`, value: s ? `${s.rate}%` : undefined, icon: Percent, tone: 'text-sky-600 bg-sky-500/15 dark:text-sky-400' },
        ].map((x) => (
          <div key={x.label} className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3.5">
            <span className={cn('hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl sm:flex', x.tone)} aria-hidden>
              <x.icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-2xl leading-tight font-bold tabular-nums text-foreground">{x.value ?? '—'}</p>
              <p className="text-xs leading-snug text-muted-foreground">{x.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Per-caller leaderboard (admins) */}
      {isAdmin && (data?.byCaller.length ?? 0) > 0 && (
        <section aria-labelledby="by-caller" className="rounded-2xl border border-border bg-card">
          <h2 id="by-caller" className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
            <Users className="h-4 w-4 text-primary" aria-hidden /> By caller
          </h2>
          <ul className="divide-y divide-border">
            {data!.byCaller.map((c, i) => (
              <li key={c.caller_id ?? 'none'} className="flex items-center gap-3 px-4 py-3">
                <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold', i === 0 && c.customers > 0 ? 'bg-amber-500 text-white' : 'bg-muted text-muted-foreground')}>
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground">{c.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.caller_id ? `${c.customers} of ${c.leads} leads · ${c.rate}%` : `${c.customers} customers without a caller`}
                  </p>
                  {c.caller_id && c.leads > 0 && (
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
                      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, c.rate)}%` }} />
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <p className="font-semibold tabular-nums text-foreground">{c.customers}</p>
                  <p className="text-xs tabular-nums text-muted-foreground">{money(c.revenue)}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Toolbar */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or number…"
            aria-label="Search name or number"
            className="h-11 rounded-xl pr-10 pl-10 text-base sm:text-sm"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground hover:bg-muted">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div role="group" aria-label="When" className="flex gap-1 overflow-x-auto rounded-xl bg-muted/50 p-1">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              aria-pressed={range === r.key}
              onClick={() => setRange(r.key)}
              className={cn(
                'min-h-9 shrink-0 rounded-lg px-3.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none',
                range === r.key ? 'bg-background text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {data === null ? (
        <div className="flex h-48 items-center justify-center" role="status" aria-label="Loading">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : data.conversions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center">
          <BadgeCheck className="mx-auto h-9 w-9 text-muted-foreground" aria-hidden />
          <p className="mt-3 text-lg font-semibold text-foreground">{search ? 'No customers match this search' : 'No customers yet'}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            A lead becomes a customer as soon as a payment is recorded for them — Mark fully paid, an instalment (advance), or the paid tag.
          </p>
        </div>
      ) : (
        <ul className={cn('space-y-3 transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          {convRowsVisible.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" aria-hidden>
                <BadgeCheck className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-foreground">{c.name || c.phone || 'Unknown contact'}</p>
                <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                  {c.phone && c.name && <span className="tabular-nums text-muted-foreground">{c.phone}</span>}
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-700 dark:text-emerald-300">{SOURCE_LABEL[c.source] ?? c.source}</span>
                  {c.caller_name && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-muted-foreground">
                      <UserRound className="h-3 w-3" aria-hidden /> {c.caller_name}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Became a customer {formatDistanceToNow(new Date(c.converted_at), { addSuffix: true })} · {format(new Date(c.converted_at), 'd MMM yyyy')}
                </p>
                {c.note && <p className="mt-1.5 rounded-lg bg-muted px-2.5 py-1.5 text-sm text-foreground">{c.note}</p>}
              </div>
              <div className="text-right">
                <p className="text-lg font-bold tabular-nums text-foreground">{money(c.amount)}</p>
                <p className="text-xs text-muted-foreground">received</p>
              </div>
              {isAdmin && (
                <div className="flex w-full justify-end gap-2 border-t border-border pt-3 sm:w-auto sm:border-0 sm:pt-0">
                  <Button variant="outline" className="h-10 rounded-xl" onClick={() => setEditing(c)}>
                    <Pencil className="h-4 w-4" aria-hidden /> Edit
                  </Button>
                  <Button variant="ghost" className="h-10 rounded-xl text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => void remove(c)}>
                    <Trash2 className="h-4 w-4" aria-hidden /> Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
          {convRowsMore && <li ref={convRowsSentinel} className="h-8 list-none" aria-hidden />}
        </ul>
      )}

      {editing && data && (
        <EditDialog key={editing.id} conversion={editing} callers={data.callers} onClose={() => setEditing(null)} onSaved={() => void load()} />
      )}
    </div>
  );
}

function EditDialog({
  conversion,
  callers,
  onClose,
  onSaved,
}: {
  conversion: Conversion;
  callers: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState(conversion.amount === null ? '' : String(conversion.amount));
  const [callerId, setCallerId] = useState(conversion.caller_id ?? '');
  const [date, setDate] = useState(format(new Date(conversion.converted_at), 'yyyy-MM-dd'));
  const [note, setNote] = useState(conversion.note ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/conversions/${conversion.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: amount === '' ? null : Number(amount),
          caller_id: callerId || null,
          converted_at: new Date(`${date}T12:00:00`).toISOString(),
          note,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.error(json?.error || 'Could not save');
      toast.success('Saved');
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const field = 'mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none';
  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit customer · {conversion.name || conversion.phone}</DialogTitle>
          <DialogDescription>Changes here are kept even when new payments come in.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-sm font-medium text-foreground">
            Amount received
            <input type="number" min={0} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={field} />
          </label>
          <label className="block text-sm font-medium text-foreground">
            Caller (who converted them)
            <select value={callerId} onChange={(e) => setCallerId(e.target.value)} className={field}>
              <option value="">No caller</option>
              {callers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-foreground">
            Became a customer on
            <input type="date" value={date} max={format(new Date(), 'yyyy-MM-dd')} onChange={(e) => setDate(e.target.value)} className={field} />
          </label>
          <label className="block text-sm font-medium text-foreground">
            Note
            <Textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className="mt-1 rounded-xl" placeholder="e.g. Paid in two parts" />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || !date}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
