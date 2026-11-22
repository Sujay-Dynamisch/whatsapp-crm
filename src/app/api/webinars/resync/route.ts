// ============================================================
// POST /api/webinars/resync   (migration 098)
// Leads booked into a time that is no longer a scheduled session (booked
// by the built-in daily rule before the schedule was set up, or before a
// change) are moved to the right scheduled sessions by a background job.
// Explicit admin action — never automatic.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { bookedImpact, orphanBookedIsos } from '@/lib/journeys/engine';
import { logWebinarChange, requireWebinarAccess, webinarReadiness } from '@/lib/webinars/server';

export async function POST() {
  try {
    const { admin, accountId, userId } = await requireWebinarAccess('edit');
    const readiness = await webinarReadiness(admin, accountId);
    if (!readiness.ready) return NextResponse.json({ error: `Not started: ${readiness.problems.join(' ')}` }, { status: 409 });
    let total = 0;
    for (const iso of await orphanBookedIsos(admin, accountId, new Date())) total += (await bookedImpact(admin, accountId, iso)).booked;
    if (!total) return NextResponse.json({ error: 'Every booked lead is already on a scheduled session.' }, { status: 409 });
    const { data: job, error } = await admin
      .from('webinar_moves')
      .insert({ account_id: accountId, reason: 'resync', requested_by: userId, total })
      .select('id')
      .single();
    if (error) throw error;
    await logWebinarChange(admin, { accountId, sessionId: null, action: 'resync', detail: `Moved leads off unscheduled times`, affected: total, actorId: userId });
    return NextResponse.json({ ok: true, jobId: job.id, total });
  } catch (error) {
    return toErrorResponse(error);
  }
}
