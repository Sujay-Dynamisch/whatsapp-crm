// ============================================================
// PATCH /api/webinars/[id]   (migration 097)
//   { date?, time?, link?, note?, status?: 'scheduled' | 'cancelled' }
// Cancelling a session, or changing its date / time, moves every lead
// booked into it to the next scheduled session and messages them the
// new details (the journey's "session changed" step).
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { UUID_RE } from '@/lib/journeys/api';
import { liveJourneyDeps } from '@/lib/journeys/dispatch';
import { moveBookedRuns } from '@/lib/journeys/engine';
import { toIstIso } from '@/lib/journeys/webinar';
import { istToUtc, requireWebinarAccess } from '@/lib/webinars/server';

export const maxDuration = 300;

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { admin, accountId } = await requireWebinarAccess('edit');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as { date?: unknown; time?: unknown; link?: unknown; note?: unknown; status?: unknown };

    const { data: s } = await admin.from('webinar_sessions').select('*').eq('id', id).eq('account_id', accountId).maybeSingle();
    if (!s) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    if (Date.parse(s.starts_at as string) <= Date.now()) {
      return NextResponse.json({ error: 'This session has already started' }, { status: 409 });
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const oldIso = toIstIso(s.starts_at as string);
    if (body.date !== undefined || body.time !== undefined) {
      const date = typeof body.date === 'string' ? body.date : oldIso.slice(0, 10);
      const time = typeof body.time === 'string' ? body.time : oldIso.slice(11, 16);
      const utc = istToUtc(date, time);
      if (!utc) return NextResponse.json({ error: 'Enter a valid date and time' }, { status: 400 });
      if (Date.parse(utc) <= Date.now()) return NextResponse.json({ error: 'The new time must be in the future' }, { status: 400 });
      update.starts_at = utc;
    }
    if (body.link !== undefined) {
      const link = typeof body.link === 'string' && body.link.trim() ? body.link.trim().slice(0, 500) : null;
      if (link && !/^https:\/\//i.test(link)) return NextResponse.json({ error: 'The link must start with https://' }, { status: 400 });
      update.link = link;
    }
    if (body.note !== undefined) update.note = String(body.note ?? '').trim().slice(0, 200) || null;
    if (body.status !== undefined) {
      if (body.status !== 'scheduled' && body.status !== 'cancelled') {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
      }
      update.status = body.status;
    }

    const { error } = await admin.from('webinar_sessions').update(update).eq('id', id).eq('account_id', accountId);
    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'Another session is already scheduled at that time' }, { status: 409 });
      throw error;
    }

    // Booked leads follow: the session they were booked into is gone or moved.
    const timeChanged = update.starts_at !== undefined && update.starts_at !== new Date(s.starts_at as string).toISOString();
    const cancelled = update.status === 'cancelled' && s.status === 'scheduled';
    let moved = 0;
    if (s.status === 'scheduled' && (cancelled || timeChanged)) {
      const r = await moveBookedRuns(admin, accountId, oldIso, liveJourneyDeps);
      moved = r.moved;
      if (r.errors.length) console.error('[webinars] move booked runs:', r.errors.slice(0, 5));
    }
    return NextResponse.json({ ok: true, moved });
  } catch (error) {
    return toErrorResponse(error);
  }
}
