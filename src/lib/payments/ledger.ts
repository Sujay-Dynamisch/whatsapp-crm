// ============================================================
// Payment ledger per lead (migration 095): full price + type (full /
// advance) and every payment received. The balance drives the existing
// "paid" state: balance 0 → paid (paid tag, journeys stop); an edit that
// opens a balance again → not paid. Leads without a price set keep the
// old one-click "Mark as paid" behaviour.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { ensureTag, stopRunsExitingOnTag, tagIdsByName, type PaymentTracking } from '@/lib/payments/tracking';

export const PAYMENT_METHODS = ['upi', 'card', 'netbanking', 'cash', 'other'] as const;

export interface Installment {
  id: string;
  amount: number;
  method: string | null;
  paid_on: string;
  note: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Ledger {
  plan: { total_price: number; plan: 'full' | 'advance'; updated_at: string } | null;
  installments: Installment[];
  paid: number;
  balance: number | null;
}

export async function loadLedger(db: SupabaseClient, accountId: string, contactId: string): Promise<Ledger> {
  const [{ data: plan }, { data: rows }] = await Promise.all([
    db.from('payment_plans').select('total_price, plan, updated_at').eq('account_id', accountId).eq('contact_id', contactId).maybeSingle(),
    db
      .from('payment_installments')
      .select('id, amount, method, paid_on, note, created_by, updated_by, created_at, updated_at')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('paid_on', { ascending: true })
      .order('created_at', { ascending: true }),
  ]);
  const installments = ((rows ?? []) as Installment[]).map((r) => ({ ...r, amount: Number(r.amount) }));
  const paid = Math.round(installments.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const p = plan ? { total_price: Number(plan.total_price), plan: plan.plan as 'full' | 'advance', updated_at: plan.updated_at as string } : null;
  return { plan: p, installments, paid, balance: p ? Math.max(0, Math.round((p.total_price - paid) * 100) / 100) : null };
}

/** Bring the lead's paid state in line with its ledger. Returns the ledger. */
export async function reconcileLedger(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; userId: string; who: string; tracking: PaymentTracking }
): Promise<Ledger> {
  const ledger = await loadLedger(db, args.accountId, args.contactId);
  if (!ledger.plan || ledger.plan.total_price <= 0) return ledger;

  const { data: record } = await db.from('payment_records').select('id').eq('contact_id', args.contactId).maybeSingle();
  const fullyPaid = ledger.paid >= ledger.plan.total_price;

  if (fullyPaid) {
    const last = ledger.installments.at(-1);
    await db.from('payment_records').upsert(
      {
        account_id: args.accountId,
        contact_id: args.contactId,
        amount: ledger.paid,
        method: last?.method ?? null,
        note: ledger.plan.plan === 'advance' ? `Advance + ${ledger.installments.length - 1} more payment(s)` : null,
        paid_at: record ? undefined : new Date().toISOString(),
        marked_by: args.userId,
      },
      { onConflict: 'contact_id' }
    );
    if (!record) {
      const paidTagId = await ensureTag(db, args.accountId, args.userId, args.tracking.paid_tag);
      await db.from('contact_tags').upsert({ contact_id: args.contactId, tag_id: paidTagId }, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true });
      await stopRunsExitingOnTag(db, {
        accountId: args.accountId,
        contactId: args.contactId,
        tagId: paidTagId,
        reason: `Fully paid — recorded by ${args.who}`,
        now: new Date(),
      });
    }
  } else if (record) {
    // A balance is open again: back to not paid.
    await db.from('payment_records').delete().eq('contact_id', args.contactId);
    const paidTagId = (await tagIdsByName(db, args.accountId, [args.tracking.paid_tag])).get(args.tracking.paid_tag.toLowerCase());
    if (paidTagId) await db.from('contact_tags').delete().eq('contact_id', args.contactId).eq('tag_id', paidTagId);
  }
  return ledger;
}
