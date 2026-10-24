// ============================================================
// POST /api/journeys/[id]/runs/[runId]/stop
// Stop one contact's run by hand from the run history. Agents and up.
// The run is checked against the caller's account, then stopped by the
// engine (service role — only the engine writes enrollments).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { UUID_RE } from '@/lib/journeys/api';
import { stopEnrollment } from '@/lib/journeys/engine';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const { id, runId } = await params;
    if (!UUID_RE.test(id) || !UUID_RE.test(runId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    const { data: profile } = await supabase.from('profiles').select('full_name').eq('user_id', userId).maybeSingle();
    const who = (profile?.full_name as string | null)?.trim() || 'a team member';

    const outcome = await stopEnrollment(supabaseAdmin(), {
      enrollmentId: runId,
      journeyId: id,
      accountId,
      reason: `Stopped by ${who}`,
      now: new Date(),
    });
    if (outcome === 'not_found') return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    if (outcome === 'busy') {
      return NextResponse.json({ error: 'This run is executing a step right now — try again in a moment' }, { status: 409 });
    }
    if (outcome === 'finished') return NextResponse.json({ error: 'This run has already finished' }, { status: 409 });
    return NextResponse.json({ stopped: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
