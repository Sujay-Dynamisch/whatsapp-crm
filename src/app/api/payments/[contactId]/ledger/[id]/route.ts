// ============================================================
// /api/payments/[contactId]/ledger/[id]   (migration 095)
//   PATCH  { amount?, method?, paid_on?, note? }  edit a payment
//   DELETE                                        remove a payment
// The paid state follows the new balance.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { UUID_RE } from '@/lib/journeys/api';
import { reconcileLedger } from '@/lib/payments/ledger';
import { guard, parsePayment } from '@/lib/payments/ledger-api';
import { hasMinRole } from '@/lib/auth/roles';
import { TrashError, trashPayment } from '@/lib/trash/server';

type Params = { params: Promise<{ contactId: string; id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { contactId, id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const g = await guard(contactId, true);
    if ('error' in g) return g.error;
    const parsed = parsePayment((await request.json().catch(() => ({}))) as Record<string, unknown>, true);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { data, error } = await g.db
      .from('payment_installments')
      .update({ ...parsed.value, updated_by: g.ctx.userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('contact_id', contactId)
      .eq('account_id', g.ctx.accountId)
      .select('id');
    if (error) throw error;
    if (!data?.length) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
    const ledger = await reconcileLedger(g.db, { accountId: g.ctx.accountId, contactId, userId: g.ctx.userId, who: g.who, tracking: g.tracking });
    return NextResponse.json(ledger);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { contactId, id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const g = await guard(contactId, true);
    if ('error' in g) return g.error;
    // Admins only (100); the entry goes to the trash and can be restored.
    if (!hasMinRole(g.ctx.role, 'admin')) return NextResponse.json({ error: 'Only an admin can delete payments' }, { status: 403 });
    try {
      await trashPayment(g.db, { accountId: g.ctx.accountId, userId: g.ctx.userId, contactId, id });
    } catch (err) {
      if (err instanceof TrashError) return NextResponse.json({ error: err.message }, { status: err.status });
      throw err;
    }
    const ledger = await reconcileLedger(g.db, { accountId: g.ctx.accountId, contactId, userId: g.ctx.userId, who: g.who, tracking: g.tracking });
    return NextResponse.json(ledger);
  } catch (error) {
    return toErrorResponse(error);
  }
}
