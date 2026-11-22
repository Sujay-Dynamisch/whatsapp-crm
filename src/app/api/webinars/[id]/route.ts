// ============================================================
// /api/webinars/[id]   (migrations 097 / 098)
//   POST   { action: 'cancel' | 'time', date?, time? }  → impact preview
//          (who is booked, what they already got, where they'll go,
//           and whether the change is allowed)
//   PATCH  { date?, time?, link?, note?, status? }       → apply
//
// Safety rules (refused with a clear error):
//   * cancelling / re-timing while the journey or the background job
//     does not follow the schedule yet (leads would not be moved);
//   * cancelling when no later session exists (leads would fall back to
//     the built-in daily time — add the next session first);
//   * a new time in the past, or less than 30 min ahead when leads are
//     booked; editing a session that has started.
// Booked leads are moved by a background job (webinar_moves), with
// progress on the page; every change is written to webinar_changes.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { UUID_RE } from '@/lib/journeys/api';
import { bookedImpact, updateBookedLink } from '@/lib/journeys/engine';
import { toIstIso } from '@/lib/journeys/webinar';
import {
  istToUtc,
  logWebinarChange,
  nextScheduledSession,
  requireWebinarAccess,
  sessionLabel,
  webinarReadiness,
} from '@/lib/webinars/server';

type Params = { params: Promise<{ id: string }> };
const MIN_LEAD_MS = 30 * 60_000;

async function loadSession(admin: Awaited<ReturnType<typeof requireWebinarAccess>>['admin'], accountId: string, id: string) {
  const { data } = await admin.from('webinar_sessions').select('*').eq('id', id).eq('account_id', accountId).maybeSingle();
  return data as { id: string; starts_at: string; status: string; link: string | null } | null;
}

/** Impact preview for a cancel or a time change. */
export async function POST(request: Request, { params }: Params) {
  try {
    const { admin, accountId } = await requireWebinarAccess('edit');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as { action?: string; date?: string; time?: string };
    const s = await loadSession(admin, accountId, id);
    if (!s) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

    const readiness = await webinarReadiness(admin, accountId);
    const impact = await bookedImpact(admin, accountId, toIstIso(s.starts_at));
    let blocked: string | null = null;
    let goesTo: string | null = null;

    if (Date.parse(s.starts_at) <= Date.now()) blocked = 'This session has already started.';
    else if (body.action === 'cancel') {
      const next = await nextScheduledSession(admin, accountId, s.id);
      if (next) goesTo = sessionLabel(next.starts_at);
      else blocked = 'There is no later session scheduled. Add the next session first — otherwise booked leads would fall back to the default daily time.';
    } else if (body.action === 'time') {
      const utc = istToUtc(String(body.date ?? ''), String(body.time ?? ''));
      if (!utc) blocked = 'Enter a valid date and time.';
      else if (Date.parse(utc) <= Date.now()) blocked = 'The new time is in the past.';
      else if (impact.booked > 0 && Date.parse(utc) < Date.now() + MIN_LEAD_MS) blocked = 'Leads are booked — the new time must be at least 30 minutes from now.';
      else goesTo = sessionLabel(utc);
    }
    if (!blocked && impact.booked > 0 && !readiness.ready) blocked = readiness.problems.join(' ');

    return NextResponse.json({
      session: sessionLabel(s.starts_at),
      booked: impact.booked,
      confirmationSent: impact.booked,
      reminder1Sent: impact.reminder1Sent,
      goesTo,
      blocked,
      warnings: readiness.warnings,
      messagesToSend: readiness.warnings.length ? 0 : impact.booked,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { admin, accountId, userId } = await requireWebinarAccess('edit');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as { date?: unknown; time?: unknown; link?: unknown; note?: unknown; status?: unknown };

    const s = await loadSession(admin, accountId, id);
    if (!s) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    if (Date.parse(s.starts_at) <= Date.now()) {
      return NextResponse.json({ error: 'This session has already started — it can no longer be changed.' }, { status: 409 });
    }

    const oldIso = toIstIso(s.starts_at);
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    let newStart: string | null = null;
    if (body.date !== undefined || body.time !== undefined) {
      const date = typeof body.date === 'string' ? body.date : oldIso.slice(0, 10);
      const time = typeof body.time === 'string' ? body.time : oldIso.slice(11, 16);
      const utc = istToUtc(date, time);
      if (!utc) return NextResponse.json({ error: 'Enter a valid date and time' }, { status: 400 });
      if (utc !== new Date(s.starts_at).toISOString()) {
        if (Date.parse(utc) <= Date.now()) return NextResponse.json({ error: 'The new time is in the past.' }, { status: 400 });
        newStart = utc;
        update.starts_at = utc;
      }
    }
    let linkChanged = false;
    if (body.link !== undefined) {
      const link = typeof body.link === 'string' && body.link.trim() ? body.link.trim().slice(0, 500) : null;
      if (link && !/^https:\/\//i.test(link)) return NextResponse.json({ error: 'The link must start with https://' }, { status: 400 });
      if (link !== (s.link ?? null)) {
        update.link = link;
        linkChanged = true;
      }
    }
    if (body.note !== undefined) update.note = String(body.note ?? '').trim().slice(0, 200) || null;
    let cancelling = false;
    let restoring = false;
    if (body.status !== undefined) {
      if (body.status !== 'scheduled' && body.status !== 'cancelled') return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
      cancelling = body.status === 'cancelled' && s.status === 'scheduled';
      restoring = body.status === 'scheduled' && s.status === 'cancelled';
      if (cancelling || restoring) update.status = body.status;
    }

    // Leads move only when a scheduled session is cancelled or re-timed.
    const moves = s.status === 'scheduled' && (cancelling || !!newStart);
    const impact = moves ? await bookedImpact(admin, accountId, oldIso) : { booked: 0, reminder1Sent: 0 };
    if (moves && impact.booked > 0) {
      const readiness = await webinarReadiness(admin, accountId);
      if (!readiness.ready) {
        return NextResponse.json({ error: `Not changed: ${readiness.problems.join(' ')}`, problems: readiness.problems }, { status: 409 });
      }
      if (cancelling && !(await nextScheduledSession(admin, accountId, s.id))) {
        return NextResponse.json(
          { error: 'Not cancelled: there is no later session. Add the next session first — otherwise booked leads would fall back to the default daily time.' },
          { status: 409 }
        );
      }
      if (newStart && Date.parse(newStart) < Date.now() + MIN_LEAD_MS) {
        return NextResponse.json({ error: 'Leads are booked — the new time must be at least 30 minutes from now.' }, { status: 400 });
      }
    }

    const { error } = await admin.from('webinar_sessions').update(update).eq('id', id).eq('account_id', accountId);
    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'Another session is already scheduled at that time.' }, { status: 409 });
      throw error;
    }

    let jobId: string | null = null;
    if (moves && impact.booked > 0) {
      const { data: job } = await admin
        .from('webinar_moves')
        .insert({ account_id: accountId, session_id: s.id, from_iso: oldIso, reason: cancelling ? 'cancelled' : 'time_changed', requested_by: userId, total: impact.booked })
        .select('id')
        .single();
      jobId = (job?.id as string | undefined) ?? null;
    }
    const linkSynced = linkChanged && s.status === 'scheduled' && !newStart && !cancelling
      ? await updateBookedLink(admin, accountId, oldIso, (update.link as string | null) ?? null)
      : 0;

    const label = sessionLabel(s.starts_at);
    const detail = cancelling
      ? `Cancelled ${label}`
      : restoring
        ? `Restored ${label}`
        : newStart
          ? `Moved ${label} → ${sessionLabel(newStart)}`
          : linkChanged
            ? `Changed the Zoom link of ${label}`
            : `Edited ${label}`;
    await logWebinarChange(admin, {
      accountId,
      sessionId: s.id,
      action: cancelling ? 'cancel' : restoring ? 'restore' : newStart ? 'time' : linkChanged ? 'link' : 'edit',
      detail,
      affected: moves ? impact.booked : linkSynced,
      actorId: userId,
    });
    return NextResponse.json({ ok: true, booked: impact.booked, jobId, linkSynced });
  } catch (error) {
    return toErrorResponse(error);
  }
}
