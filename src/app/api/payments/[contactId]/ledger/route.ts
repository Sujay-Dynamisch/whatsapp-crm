// ============================================================
// /api/payments/[contactId]/ledger   (migration 095)
//   GET   the lead's price, type, payments and balance
//   PUT   { total_price, plan: 'full' | 'advance' }
//   POST  { amount, method?, paid_on?, note? }   record a payment
// Agents and up; scoped callers only for their own leads (RLS check).
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { loadLedger, reconcileLedger } from '@/lib/payments/ledger';
import { guard, parsePayment } from '@/lib/payments/ledger-api';

type Params = { params: Promise<{ contactId: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const { contactId } = await params;
    const g = await guard(contactId, false);
    if ('error' in g) return g.error;
    const ledger = await loadLedger(g.db, g.ctx.accountId, contactId);
    // Names for "recorded by".
    const ids = [...new Set(ledger.installments.flatMap((i) => [i.created_by, i.updated_by]).filter(Boolean))] as string[];
    const { data: people } = ids.length ? await g.db.from('profiles').select('user_id, full_name').in('user_id', ids) : { data: [] };
    const names = Object.fromEntries((people ?? []).map((p) => [p.user_id as string, (p.full_name as string) || '']));
    return NextResponse.json({ contact: g.contact, currency: g.tracking.currency, ...ledger, names });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const { contactId } = await params;
    const g = await guard(contactId, true);
    if ('error' in g) return g.error;
    const body = (await request.json().catch(() => ({}))) as { total_price?: unknown; plan?: unknown };
    const total = Number(body.total_price);
    if (!Number.isFinite(total) || total <= 0) return NextResponse.json({ error: 'Enter the full price' }, { status: 400 });
    const plan = body.plan === 'advance' ? 'advance' : 'full';
    const { error } = await g.db.from('payment_plans').upsert(
      {
        contact_id: contactId,
        account_id: g.ctx.accountId,
        total_price: Math.round(total * 100) / 100,
        plan,
        updated_by: g.ctx.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'contact_id' }
    );
    if (error) throw error;
    const ledger = await reconcileLedger(g.db, { accountId: g.ctx.accountId, contactId, userId: g.ctx.userId, who: g.who, tracking: g.tracking });
    return NextResponse.json(ledger);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { contactId } = await params;
    const g = await guard(contactId, true);
    if ('error' in g) return g.error;
    const parsed = parsePayment((await request.json().catch(() => ({}))) as Record<string, unknown>);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { error } = await g.db.from('payment_installments').insert({
      ...parsed.value,
      account_id: g.ctx.accountId,
      contact_id: contactId,
      created_by: g.ctx.userId,
      updated_by: g.ctx.userId,
    });
    if (error) throw error;
    const ledger = await reconcileLedger(g.db, { accountId: g.ctx.accountId, contactId, userId: g.ctx.userId, who: g.who, tracking: g.tracking });
    return NextResponse.json(ledger);
  } catch (error) {
    return toErrorResponse(error);
  }
}
