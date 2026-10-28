// ============================================================
// GET /api/callbacks?status=&from=&to=&q=&tz=   (migration 058)
// Callback requests for the Callbacks page: the filtered list, the
// headline counts and a 14-day per-day series. `tz` is the browser's
// UTC offset in minutes (Date#getTimezoneOffset) so "today" and the
// daily buckets follow the viewer's clock.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';

const STATUSES = ['new', 'called', 'no_answer', 'done'];
const DAYS = 14;
const DAY_MS = 864e5;

/** Local-midnight (as a UTC instant) of the day containing `t`. */
function localDayStart(t: number, offsetMin: number): number {
  const local = t - offsetMin * 60_000;
  return local - (((local % DAY_MS) + DAY_MS) % DAY_MS) + offsetMin * 60_000;
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const p = new URL(request.url).searchParams;
    const tz = Math.max(-840, Math.min(840, Number(p.get('tz')) || 0));
    const status = p.get('status');
    const from = p.get('from');
    const to = p.get('to');
    const search = (p.get('q') ?? '').replace(/[^\p{L}\p{N} +@.\-_]/gu, '').trim();

    let q = supabase
      .from('callback_requests')
      .select(
        `id, contact_id, conversation_id, status, source, note, requested_at, handled_at, handled_by, contacts${search ? '!inner' : ''}(name, phone)`
      )
      .eq('account_id', accountId)
      .order('requested_at', { ascending: false })
      .limit(300);
    if (status === 'open') q = q.neq('status', 'done');
    else if (status && STATUSES.includes(status)) q = q.eq('status', status);
    if (from && !Number.isNaN(Date.parse(from))) q = q.gte('requested_at', from);
    if (to && !Number.isNaN(Date.parse(to))) q = q.lt('requested_at', to);
    if (search) q = q.or(`name.ilike.%${search}%,phone.ilike.%${search}%`, { referencedTable: 'contacts' });
    const { data, error } = await q;
    if (error) throw error;

    // Headline counts + daily series from the last 14 days in one read.
    const now = Date.now();
    const todayStart = localDayStart(now, tz);
    const seriesStart = todayStart - (DAYS - 1) * DAY_MS;
    const [{ data: recent }, { count: open }] = await Promise.all([
      supabase
        .from('callback_requests')
        .select('requested_at, handled_at, status')
        .eq('account_id', accountId)
        .gte('requested_at', new Date(seriesStart).toISOString())
        .limit(10000),
      supabase
        .from('callback_requests')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .neq('status', 'done'),
    ]);
    const daily = Array.from({ length: DAYS }, (_, i) => ({
      date: new Date(seriesStart + i * DAY_MS - tz * 60_000).toISOString().slice(0, 10),
      count: 0,
    }));
    let today = 0;
    for (const r of recent ?? []) {
      const at = Date.parse(r.requested_at as string);
      const idx = Math.floor((at - seriesStart) / DAY_MS);
      if (idx >= 0 && idx < DAYS) daily[idx].count++;
      if (at >= todayStart) today++;
    }
    const { count: handledToday } = await supabase
      .from('callback_requests')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .in('status', ['called', 'done'])
      .gte('handled_at', new Date(todayStart).toISOString());

    return NextResponse.json({
      requests: (data ?? []).map((r) => {
        const c = (Array.isArray(r.contacts) ? r.contacts[0] : r.contacts) as { name?: string; phone?: string } | null;
        return { ...r, contacts: undefined, contact_name: c?.name ?? null, contact_phone: c?.phone ?? null };
      }),
      stats: { open: open ?? 0, today, handled_today: handledToday ?? 0 },
      daily,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
