// ============================================================
// GET /api/failed-messages?from=&to=&status=open|resolved|all&tz=
// (feature 'failed_messages', migration 060). The day's failed sends
// with a plain-words reason and what can be done, plus a 14-day count.
// `tz` = the browser's Date#getTimezoneOffset (minutes) for the series.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { listFailed } from '@/lib/failed-messages/service';

const DAY = 864e5;
const DAYS = 14;

export async function GET(request: Request) {
  try {
    const { accountId } = await getCurrentAccount();
    const p = new URL(request.url).searchParams;
    const now = new Date();
    const to = Date.parse(p.get('to') ?? '') || now.getTime();
    const from = Date.parse(p.get('from') ?? '') || to - DAY;
    if (to - from > 31 * DAY || from >= to) return NextResponse.json({ error: 'Choose a range of up to 31 days' }, { status: 400 });
    const status = (['open', 'resolved', 'all'] as const).find((s) => s === p.get('status')) ?? 'open';
    const tz = Math.max(-840, Math.min(840, Number(p.get('tz')) || 0));

    const db = supabaseAdmin();
    const list = await listFailed(db, accountId, { from: new Date(from).toISOString(), to: new Date(to).toISOString(), status, now });

    // Failed per local day, last 14 days (both sources, retry steps excluded).
    const local = (t: number) => t - tz * 60_000;
    const todayStart = Math.floor(local(now.getTime()) / DAY) * DAY;
    const seriesStart = todayStart - (DAYS - 1) * DAY + tz * 60_000;
    const daily = Array.from({ length: DAYS }, (_, i) => ({
      date: new Date(todayStart - (DAYS - 1 - i) * DAY).toISOString().slice(0, 10),
      count: 0,
    }));
    const since = new Date(seriesStart).toISOString();
    const [{ data: j }, { data: m }] = await Promise.all([
      db.from('journey_messages').select('created_at, resolved').eq('account_id', accountId).eq('status', 'failed').gte('created_at', since).limit(20000),
      db
        .from('messages')
        .select('created_at, conversations!inner(account_id)')
        .eq('conversations.account_id', accountId)
        .eq('status', 'failed')
        .in('sender_type', ['agent', 'bot'])
        .gte('created_at', since)
        .limit(20000),
    ]);
    for (const r of [...(j ?? []).filter((x) => x.resolved !== 'retried'), ...(m ?? [])]) {
      const i = Math.floor((Date.parse(r.created_at as string) - seriesStart) / DAY);
      if (i >= 0 && i < DAYS) daily[i].count++;
    }
    return NextResponse.json({ ...list, daily });
  } catch (error) {
    return toErrorResponse(error);
  }
}
