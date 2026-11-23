// ============================================================
// POST /api/callbacks/[id]/payment-link   (migration 099)
// The team sends the payment link to the lead from a callback card —
// works at every stage (new / called / no answer / done). Agents and up;
// the request must be visible to the user (callers: their own leads).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { PaymentLinkError, sendCallbackPaymentLink } from '@/lib/callbacks/timeline';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { UUID_RE } from '@/lib/journeys/api';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const { data: visible } = await supabase.from('callback_requests').select('id').eq('id', id).eq('account_id', accountId).maybeSingle();
    if (!visible) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

    try {
      const r = await sendCallbackPaymentLink(supabaseAdmin(), { accountId, userId, callbackId: id });
      return NextResponse.json({ ok: true, via: r.via });
    } catch (err) {
      if (err instanceof PaymentLinkError) return NextResponse.json({ error: err.message }, { status: err.status });
      // Network / TLS failure reaching WhatsApp (e.g. a firewall) — nothing was sent.
      if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
        return NextResponse.json({ error: 'Could not reach WhatsApp from the server — nothing was sent. Check the internet connection or firewall and try again.' }, { status: 502 });
      }
      throw err;
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
