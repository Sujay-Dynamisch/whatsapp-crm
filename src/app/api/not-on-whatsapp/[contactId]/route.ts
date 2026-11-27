// POST /api/not-on-whatsapp/[contactId]  { phone?, step }
// The caller got the lead's WhatsApp number: save it and start the
// WhatsApp journey at the chosen step (src/lib/contacts/whatsapp-restart.ts).
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { UUID_RE } from '@/lib/journeys/api';
import { liveJourneyDeps } from '@/lib/journeys/dispatch';
import { fixNumberAndRestart } from '@/lib/contacts/whatsapp-restart';

export async function POST(request: Request, { params }: { params: Promise<{ contactId: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { contactId } = await params;
    if (!UUID_RE.test(contactId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    // Visible to this user? (callers: only their own leads — RLS)
    const { data: visible } = await supabase.from('contacts').select('id').eq('id', contactId).eq('account_id', accountId).maybeSingle();
    if (!visible) return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    const body = (await request.json().catch(() => ({}))) as { phone?: unknown; step?: unknown };
    const r = await fixNumberAndRestart(
      supabaseAdmin(),
      {
        accountId,
        contactId,
        phone: typeof body.phone === 'string' && body.phone.trim() ? body.phone : null,
        stepId: String(body.step ?? ''),
      },
      liveJourneyDeps
    );
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ started: r.started });
  } catch (error) {
    return toErrorResponse(error);
  }
}
