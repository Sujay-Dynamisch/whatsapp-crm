// ============================================================
// /api/webinars   (migration 097)
//   GET   upcoming sessions (+ last 7 days) with booked-lead counts,
//         timing rules, and a low-schedule warning
//   POST  { dates: ['YYYY-MM-DD', …], time?: 'HH:MM', link? }
//         add sessions (time defaults to the weekday / weekend default)
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { bookedImpact, countBookedRuns, orphanBookedIsos } from '@/lib/journeys/engine';
import { loadWebinarRules, toIstIso } from '@/lib/journeys/webinar';
import { DATE_RE, TIME_RE, istToUtc, isWeekendDate, logWebinarChange, requireWebinarAccess, webinarReadiness } from '@/lib/webinars/server';

export async function GET() {
  try {
    const { admin, accountId } = await requireWebinarAccess('view');
    const now = Date.now();
    const { data, error } = await admin
      .from('webinar_sessions')
      .select('id, starts_at, link, status, note, updated_at')
      .eq('account_id', accountId)
      .gte('starts_at', new Date(now - 7 * 864e5).toISOString())
      .order('starts_at', { ascending: true })
      .limit(300);
    if (error) throw error;
    const sessions = await Promise.all(
      (data ?? []).map(async (s) => {
        const upcoming = Date.parse(s.starts_at as string) > now;
        const startIso = toIstIso(s.starts_at as string);
        return {
          ...s,
          start_iso: startIso,
          upcoming,
          booked: upcoming && s.status === 'scheduled' ? await countBookedRuns(admin, accountId, startIso) : 0,
        };
      })
    );
    const upcomingCount = sessions.filter((s) => s.upcoming && s.status === 'scheduled').length;

    // Leads booked into a time that isn't a scheduled session (e.g. by the
    // built-in daily rule) — the page offers to move them.
    let orphans = 0;
    for (const iso of await orphanBookedIsos(admin, accountId, new Date())) orphans += (await bookedImpact(admin, accountId, iso)).booked;

    const [{ data: moves }, { data: changes }] = await Promise.all([
      admin.from('webinar_moves').select('id, reason, status, total, moved, errors, created_at, finished_at').eq('account_id', accountId).order('created_at', { ascending: false }).limit(10),
      admin.from('webinar_changes').select('id, action, detail, affected, actor_id, created_at').eq('account_id', accountId).order('created_at', { ascending: false }).limit(20),
    ]);
    const actorIds = [...new Set((changes ?? []).map((c) => c.actor_id as string).filter(Boolean))];
    const { data: people } = actorIds.length ? await admin.from('profiles').select('user_id, full_name').in('user_id', actorIds) : { data: [] };
    const nameOf = new Map((people ?? []).map((p) => [p.user_id as string, (p.full_name as string) || '']));

    return NextResponse.json({
      sessions,
      rules: await loadWebinarRules(admin, accountId),
      upcoming: upcomingCount,
      low: upcomingCount < 3,
      readiness: await webinarReadiness(admin, accountId),
      orphans,
      moves: moves ?? [],
      changes: (changes ?? []).map((c) => ({ ...c, actor: nameOf.get(c.actor_id as string) ?? null })),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { admin, accountId, userId } = await requireWebinarAccess('edit');
    const body = (await request.json().catch(() => ({}))) as { dates?: unknown; time?: unknown; link?: unknown };
    const dates = Array.isArray(body.dates) ? [...new Set(body.dates.map(String))].filter((d) => DATE_RE.test(d)) : [];
    if (!dates.length) return NextResponse.json({ error: 'Pick at least one date' }, { status: 400 });
    if (dates.length > 120) return NextResponse.json({ error: 'At most 120 sessions at a time' }, { status: 400 });
    const time = typeof body.time === 'string' && body.time ? body.time : null;
    if (time && !TIME_RE.test(time)) return NextResponse.json({ error: 'Enter a valid time (HH:MM)' }, { status: 400 });
    const link = typeof body.link === 'string' && body.link.trim() ? body.link.trim().slice(0, 500) : null;
    if (link && !/^https:\/\//i.test(link)) return NextResponse.json({ error: 'The link must start with https://' }, { status: 400 });

    const rules = await loadWebinarRules(admin, accountId);
    const rows = dates
      .map((d) => istToUtc(d, time ?? (isWeekendDate(d) ? rules.default_weekend_time : rules.default_weekday_time)))
      .filter((iso): iso is string => !!iso && Date.parse(iso) > Date.now())
      .map((starts_at) => ({ account_id: accountId, starts_at, link, created_by: userId }));
    if (!rows.length) return NextResponse.json({ error: 'All chosen times are in the past' }, { status: 400 });

    // Skip slots that already have a scheduled session.
    const { data: existing } = await admin
      .from('webinar_sessions')
      .select('starts_at')
      .eq('account_id', accountId)
      .eq('status', 'scheduled')
      .in('starts_at', rows.map((r) => r.starts_at));
    const taken = new Set((existing ?? []).map((r) => new Date(r.starts_at as string).toISOString()));
    const fresh = rows.filter((r) => !taken.has(r.starts_at));
    if (fresh.length) {
      const { error } = await admin.from('webinar_sessions').insert(fresh);
      if (error) throw error;
      await logWebinarChange(admin, { accountId, sessionId: null, action: 'add', detail: `Added ${fresh.length} session${fresh.length === 1 ? '' : 's'}`, affected: 0, actorId: userId });
    }
    return NextResponse.json({ added: fresh.length, skipped: rows.length - fresh.length });
  } catch (error) {
    return toErrorResponse(error);
  }
}
