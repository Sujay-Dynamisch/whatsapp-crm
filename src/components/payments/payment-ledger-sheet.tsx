'use client';

// Payment details for one lead (migration 095): full price, payment type
// (full / advance), every payment received — editable — and the balance.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Check, CircleDollarSign, Loader2, Pencil, Plus, Trash2, Wallet, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';

const METHODS: { value: string; label: string }[] = [
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'netbanking', label: 'Net banking' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
];
const methodLabel = (m: string | null) => METHODS.find((x) => x.value === m)?.label ?? '—';

interface Installment {
  id: string;
  amount: number;
  method: string | null;
  paid_on: string;
  note: string | null;
  created_by: string | null;
  updated_by: string | null;
  updated_at: string;
}
interface LedgerData {
  contact: { id: string; name: string | null; phone: string };
  currency: string;
  plan: { total_price: number; plan: 'full' | 'advance' } | null;
  installments: Installment[];
  paid: number;
  balance: number | null;
  names: Record<string, string>;
}
interface Draft {
  amount: string;
  method: string;
  paid_on: string;
  note: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const SELECT =
  'h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

function PaymentForm({
  draft,
  setDraft,
  onSave,
  onCancel,
  busy,
  saveLabel,
  currency,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSave: () => void;
  onCancel?: () => void;
  busy: boolean;
  saveLabel: string;
  currency: string;
}) {
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Amount ({currency})</span>
          <Input type="number" min="0" step="0.01" inputMode="decimal" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} placeholder="0" className="h-9 tabular-nums" />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Paid on</span>
          <Input type="date" value={draft.paid_on} max={today()} onChange={(e) => setDraft({ ...draft, paid_on: e.target.value })} className="h-9" />
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {METHODS.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => setDraft({ ...draft, method: m.value })}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              draft.method === m.value ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-muted-foreground hover:bg-muted'
            )}
          >
            {m.label}
          </button>
        ))}
      </div>
      <Input value={draft.note} maxLength={300} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="Note (optional) — e.g. transaction ID" className="h-9" />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            <X className="size-3.5" /> Cancel
          </Button>
        )}
        <Button size="sm" disabled={busy || !(Number(draft.amount) > 0)} onClick={onSave}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

export function PaymentLedgerSheet({
  contactId,
  canEdit,
  onClose,
  onChanged,
}: {
  contactId: string | null;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<LedgerData | null>(null);
  const [busy, setBusy] = useState(false);
  const [price, setPrice] = useState('');
  const [plan, setPlan] = useState<'full' | 'advance'>('full');
  const [draft, setDraft] = useState<Draft>({ amount: '', method: 'upi', paid_on: today(), note: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>({ amount: '', method: 'upi', paid_on: today(), note: '' });

  const money = useCallback(
    (n: number) => {
      try {
        return new Intl.NumberFormat('en-IN', { style: 'currency', currency: data?.currency ?? 'INR', maximumFractionDigits: 2 }).format(n);
      } catch {
        return `${data?.currency ?? ''} ${n}`;
      }
    },
    [data?.currency]
  );

  const load = useCallback(async () => {
    if (!contactId) return;
    const res = await fetch(`/api/payments/${contactId}/ledger`);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(d.error || 'Could not load payment details');
      return;
    }
    setData(d as LedgerData);
    setPrice(d.plan ? String(d.plan.total_price) : '');
    setPlan(d.plan?.plan ?? 'full');
  }, [contactId]);

  useEffect(() => {
    setData(null);
    setEditing(null);
    setDraft({ amount: '', method: 'upi', paid_on: today(), note: '' });
    void Promise.resolve().then(load);
  }, [load]);

  const call = async (url: string, method: string, body?: unknown, ok?: string) => {
    setBusy(true);
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Something went wrong');
      if (ok) toast.success(ok);
      await load();
      onChanged();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Something went wrong');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const base = `/api/payments/${contactId}/ledger`;
  const total = data?.plan?.total_price ?? 0;
  const paid = data?.paid ?? 0;
  const balance = data?.balance ?? null;
  const pct = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
  const settled = total > 0 && paid >= total;
  const planChanged = !!data && (String(data.plan?.total_price ?? '') !== price || (data.plan?.plan ?? 'full') !== plan);

  // Full payment with nothing recorded yet: suggest the whole price.
  const suggested = useMemo(() => (balance && balance > 0 ? String(balance) : ''), [balance]);

  return (
    <Sheet open={!!contactId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader className="border-b">
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
              <Wallet className="size-5" />
            </span>
            <div className="min-w-0">
              <SheetTitle className="truncate">{data?.contact.name || data?.contact.phone || 'Payment details'}</SheetTitle>
              <SheetDescription className="tabular-nums">{data?.contact.phone}</SheetDescription>
            </div>
          </div>
        </SheetHeader>

        {!data ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5 p-4">
            {/* Summary */}
            <div className="rounded-2xl border border-border bg-gradient-to-br from-card to-muted/40 p-4">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Full price</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{data.plan ? money(total) : '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Received</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{money(paid)}</p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Balance</p>
                  <p className={cn('mt-1 text-lg font-semibold tabular-nums', settled ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>
                    {balance === null ? '—' : settled ? 'Paid' : money(balance)}
                  </p>
                </div>
              </div>
              {data.plan && (
                <div className="mt-4">
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className={cn('h-full rounded-full transition-all', settled ? 'bg-emerald-500' : 'bg-amber-500')} style={{ width: `${pct}%` }} />
                  </div>
                  <p className="mt-1.5 text-right text-xs text-muted-foreground">{pct}% paid</p>
                </div>
              )}
            </div>

            {/* Price + type */}
            <section className="space-y-2.5">
              <h3 className="text-sm font-semibold text-foreground">Price & payment type</h3>
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
                {(['full', 'advance'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={!canEdit}
                    onClick={() => setPlan(p)}
                    className={cn(
                      'rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-60',
                      plan === p ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {p === 'full' ? 'Full payment' : 'Advance payment'}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {plan === 'full' ? 'Pays the whole price at once.' : 'Pays an advance now and the balance later — record each payment below.'}
              </p>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <CircleDollarSign className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    disabled={!canEdit}
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    placeholder={`Full price (${data.currency})`}
                    className="h-9 pl-8 tabular-nums"
                  />
                </div>
                {canEdit && (
                  <Button size="sm" className="h-9" disabled={busy || !planChanged || !(Number(price) > 0)} onClick={() => void call(base, 'PUT', { total_price: Number(price), plan }, 'Saved')}>
                    Save
                  </Button>
                )}
              </div>
            </section>

            {/* Payments */}
            <section className="space-y-2.5">
              <h3 className="text-sm font-semibold text-foreground">
                Payments received <span className="text-xs font-normal text-muted-foreground">({data.installments.length})</span>
              </h3>
              {data.installments.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No payments recorded yet.</p>
              ) : (
                <ul className="space-y-2">
                  {data.installments.map((p, i) => (
                    <li key={p.id} className="rounded-xl border border-border bg-card p-3">
                      {editing === p.id ? (
                        <PaymentForm
                          draft={editDraft}
                          setDraft={setEditDraft}
                          busy={busy}
                          currency={data.currency}
                          saveLabel="Save changes"
                          onCancel={() => setEditing(null)}
                          onSave={async () => {
                            const ok = await call(
                              `${base}/${p.id}`,
                              'PATCH',
                              { amount: Number(editDraft.amount), method: editDraft.method, paid_on: editDraft.paid_on, note: editDraft.note },
                              'Payment updated'
                            );
                            if (ok) setEditing(null);
                          }}
                        />
                      ) : (
                        <div className="flex items-start gap-3">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/12 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                            {i + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2">
                              <span className="font-semibold tabular-nums text-foreground">{money(p.amount)}</span>
                              {data.plan?.plan === 'advance' && i === 0 && (
                                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">Advance</span>
                              )}
                              <span className="text-xs text-muted-foreground">
                                {methodLabel(p.method)} · {format(new Date(p.paid_on), 'd MMM yyyy')}
                              </span>
                            </div>
                            {p.note && <p className="mt-0.5 truncate text-xs text-muted-foreground">{p.note}</p>}
                            <p className="mt-0.5 text-[11px] text-muted-foreground/80">
                              Recorded by {data.names[p.updated_by ?? p.created_by ?? ''] || 'team'}
                              {p.updated_by && p.updated_by !== p.created_by ? ' (edited)' : ''}
                            </p>
                          </div>
                          {canEdit && (
                            <div className="flex shrink-0 gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-8"
                                aria-label="Edit payment"
                                disabled={busy}
                                onClick={() => {
                                  setEditing(p.id);
                                  setEditDraft({ amount: String(p.amount), method: p.method ?? 'upi', paid_on: p.paid_on, note: p.note ?? '' });
                                }}
                              >
                                <Pencil className="size-3.5" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-8 text-destructive hover:text-destructive"
                                aria-label="Delete payment"
                                disabled={busy}
                                onClick={async () => {
                                  const ok = await confirmDialog({ title: `Delete the ${money(p.amount)} payment?`, description: 'The balance is recalculated.', confirmLabel: 'Delete', destructive: true });
                                  if (ok) await call(`${base}/${p.id}`, 'DELETE', undefined, 'Payment deleted');
                                }}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Add a payment */}
            {canEdit && !settled && (
              <section className="space-y-2.5 rounded-2xl border border-primary/25 bg-primary/5 p-4">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <Plus className="size-4 text-primary" />
                  {data.installments.length === 0 && plan === 'advance' ? 'Record the advance' : 'Record a payment'}
                </h3>
                {!data.plan && <p className="text-xs text-amber-700 dark:text-amber-400">Set the full price first so the balance can be tracked.</p>}
                <PaymentForm
                  draft={draft.amount === '' && suggested && plan === 'full' ? { ...draft, amount: suggested } : draft}
                  setDraft={setDraft}
                  busy={busy || !data.plan}
                  currency={data.currency}
                  saveLabel="Add payment"
                  onSave={async () => {
                    const amount = Number(draft.amount || (plan === 'full' ? suggested : ''));
                    const ok = await call(base, 'POST', { amount, method: draft.method, paid_on: draft.paid_on, note: draft.note }, 'Payment recorded');
                    if (ok) setDraft({ amount: '', method: draft.method, paid_on: today(), note: '' });
                  }}
                />
              </section>
            )}
            {settled && (
              <p className="flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500/10 px-3 py-2.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                <Check className="size-4" /> Fully paid — marked as Paid automatically.
              </p>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
