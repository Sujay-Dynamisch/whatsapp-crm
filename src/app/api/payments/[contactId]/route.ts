// ============================================================
// DELETE /api/payments/[contactId]   (migration 063)
// "Mark as not paid": removes the payment record and the paid tag.
// A journey run already stopped by the payment does not restart.
// Agents and up.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { UUID_RE } from '@/lib/journeys/api';
import { loadTracking, tagIdsByName } from '@/lib/payments/tracking';

export async function DELETE(_req: Request, { params }: { params: Promise<{ contactId: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { contactId } = await params;
    if (!UUID_RE.test(contactId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const tracking = await loadTracking(supabase, accountId);
    if (!tracking) return NextResponse.json({ error: 'not_enabled' }, { status: 404 });

    const db = supabaseAdmin();
    // RLS client: a scoped caller (086) can only change their own leads.
    const { data: contact } = await supabase.from('contacts').select('id').eq('id', contactId).eq('account_id', accountId).maybeSingle();
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

    await db.from('payment_records').delete().eq('account_id', accountId).eq('contact_id', contactId);
    const paidTagId = (await tagIdsByName(db, accountId, [tracking.paid_tag])).get(tracking.paid_tag.toLowerCase());
    if (paidTagId) await db.from('contact_tags').delete().eq('contact_id', contactId).eq('tag_id', paidTagId);
    return NextResponse.json({ paid: false });
  } catch (error) {
    return toErrorResponse(error);
  }
}
