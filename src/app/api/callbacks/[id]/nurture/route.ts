// ============================================================
// POST /api/callbacks/[id]/nurture   (migration 059)
// "Back to nurture": the callback didn't work out — close the request
// and put the lead back into their journey's nurture (the trigger's
// callback_return_node). Agents and up.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { returnToNurture, type FollowUpReason } from '@/lib/callbacks/followups';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { UUID_RE } from '@/lib/journeys/api';
import { liveJourneyDeps } from '@/lib/journeys/dispatch';

const WHY: Record<FollowUpReason, string> = {
  not_in_journey: 'This lead has never been in a journey with a nurture to go back to',
  not_configured: 'Their journey has no nurture step set for callbacks',
  opted_out: 'This lead opted out (STOP) — no more messages',
  closed: 'This lead is marked paid / closed',
  busy: 'Their journey is running a step right now — try again in a minute',
  start_failed: 'Could not restart their journey — try again',
};

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    // Through the caller's RLS client: the request must be this account's.
    const { data: req } = await supabase.from('callback_requests').select('*').eq('id', id).eq('account_id', accountId).maybeSingle();
    if (!req) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    if (req.status === 'done') return NextResponse.json({ error: 'This request is already closed' }, { status: 409 });

    const r = await returnToNurture(supabaseAdmin(), req, liveJourneyDeps, 'manual');
    if (!r.started) return NextResponse.json({ error: WHY[r.reason ?? 'start_failed'], reason: r.reason }, { status: 409 });
    return NextResponse.json({ ok: true, journeyId: r.journeyId });
  } catch (error) {
    return toErrorResponse(error);
  }
}
