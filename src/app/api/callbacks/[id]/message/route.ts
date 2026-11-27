// ============================================================
// POST /api/callbacks/[id]/message   (migration 104)
// "Send message" on a callback card: sends the lead the "We tried calling
// you" message — the exact journey step a "No answer" already sends
// (trigger setting callback_missed_node, e.g. the sg_callback_missed
// template with its "Call me again" / "Not now" buttons). Tapping
// "Call me again" then works exactly as it does after a "No answer".
// It does not change the request's status or the no-answer count.
// Agents and up; the request must be visible to the user.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { startFollowUp, type FollowUpReason } from '@/lib/callbacks/followups';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { UUID_RE } from '@/lib/journeys/api';
import { liveJourneyDeps } from '@/lib/journeys/dispatch';

const WHY: Record<FollowUpReason, string> = {
  not_in_journey: 'This lead has never been in a journey with a "We tried calling you" step',
  not_configured: 'Their journey has no "We tried calling you" step set (trigger → Callback missed step)',
  opted_out: 'This lead opted out (STOP) — no more messages',
  not_on_whatsapp: 'This number is not on WhatsApp — call them instead',
  closed: 'This lead is marked paid / closed',
  busy: 'Their journey is running a step right now — try again in a minute',
  start_failed: 'Could not send the message — try again',
};

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    // Through the caller's RLS client: the request must be this account's (callers: their own leads).
    const { data: req } = await supabase.from('callback_requests').select('id, contact_id').eq('id', id).eq('account_id', accountId).maybeSingle();
    if (!req) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

    const r = await startFollowUp(supabaseAdmin(), { accountId, contactId: req.contact_id as string, kind: 'missed' }, liveJourneyDeps);
    if (!r.started) return NextResponse.json({ error: WHY[r.reason ?? 'start_failed'], reason: r.reason }, { status: 409 });
    return NextResponse.json({ ok: true, journeyId: r.journeyId });
  } catch (error) {
    return toErrorResponse(error);
  }
}
