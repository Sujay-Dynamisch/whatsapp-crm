// ============================================================
// GET /api/callbacks?status=&from=&to=&q=&tz=   (migration 058)
// Callback requests for the Callbacks page: the filtered list, the
// headline counts and a 14-day per-day series. `tz` is the browser's
// UTC offset in minutes (Date#getTimezoneOffset) so "today" and the
// daily buckets follow the viewer's clock.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { NOT_ON_WHATSAPP_TAG } from '@/lib/contacts/not-on-whatsapp';

const STATUSES = ['new', 'called', 'no_answer', 'done'];
const DAYS = 14;
const DAY_MS = 864e5;

/** Local-midnight (as a UTC instant) of the day containing `t`. */
function localDayStart(t: number, offsetMin: number): number {
  const local = t - offsetMin * 60_000;
  return local - (((local % DAY_MS) + DAY_MS) % DAY_MS) + offsetMin * 60_000;
}

type ListRow = { assigned_caller_id: string | null; note_by: string | null; contacts: unknown; [k: string]: unknown };

/** Flatten the contact and add caller / note-author names (caller management, 086). */
async function withNames(supabase: Awaited<ReturnType<typeof getCurrentAccount>>['supabase'], rows: ListRow[]) {
  const callerIds = [...new Set(rows.flatMap((r) => [r.assigned_caller_id, r.note_by]).filter(Boolean))] as string[];
  const callerNames = new Map<string, string>();
  if (callerIds.length) {
    const { data: profs } = await supabase.from('profiles').select('user_id, full_name').in('user_id', callerIds);
    for (const p of profs ?? []) callerNames.set(p.user_id as string, (p.full_name as string) || '');
  }
  // Numbers not on WhatsApp (not-on-whatsapp.ts): the card says "call only".
  const noWa = new Set<string>();
  const contactIds = [...new Set(rows.map((r) => r.contact_id as string).filter(Boolean))];
  if (contactIds.length) {
    const { data: tag } = await supabase.from('tags').select('id').ilike('name', NOT_ON_WHATSAPP_TAG).limit(1).maybeSingle();
    if (tag) {
      const { data: links } = await supabase.from('contact_tags').select('contact_id').eq('tag_id', tag.id).in('contact_id', contactIds);
      for (const l of links ?? []) noWa.add(l.contact_id as string);
    }
  }
  return rows.map((r) => {
    const c = (Array.isArray(r.contacts) ? r.contacts[0] : r.contacts) as { name?: string; phone?: string } | null;
    return {
      ...r,
      contacts: undefined,
      contact_name: c?.name ?? null,
      contact_phone: c?.phone ?? null,
      not_on_whatsapp: noWa.has(r.contact_id as string),
      caller_name: r.assigned_caller_id ? callerNames.get(r.assigned_caller_id) ?? null : null,
      note_by_name: r.note_by ? callerNames.get(r.note_by) ?? null : null,
    };
  });
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
    // Paged: the page loads PAGE rows, "Show more" asks for the next.
    const offset = Math.max(0, Math.floor(Number(p.get('offset')) || 0));
    const limit = Math.min(200, Math.max(1, Math.floor(Number(p.get('limit')) || 60)));

    const build = (extra: string) => {
      let q = supabase
        .from('callback_requests')
        .select(
          `id, contact_id, conversation_id, status, source, note, requested_at, handled_at, handled_by, no_answer_count, priority, source_kind, assigned_caller_id, ai_meta, note_by, note_at${extra}, contacts${search ? '!inner' : ''}(name, phone)`,
          { count: offset === 0 ? 'exact' : undefined }
        )
        .eq('account_id', accountId)
        // Priority (customer-requested, 086) first; 'high' < 'normal'.
        .order('priority', { ascending: true })
        .order('requested_at', { ascending: false })
        .order('id')
        .range(offset, offset + limit - 1);
      if (status === 'open') q = q.neq('status', 'done');
      // Customer asked for a call and nobody has attended to it yet.
      else if (status === 'priority') q = q.neq('status', 'done').eq('priority', 'high');
      else if (status && STATUSES.includes(status)) q = q.eq('status', status);
      if (from && !Number.isNaN(Date.parse(from))) q = q.gte('requested_at', from);
      if (to && !Number.isNaN(Date.parse(to))) q = q.lt('requested_at', to);
      if (search) q = q.or(`name.ilike.%${search}%,phone.ilike.%${search}%`, { referencedTable: 'contacts' });
      return q;
    };
    // scheduled_for (102 — the time the customer asked to be called); older DBs without it still work.
    type Row = ListRow;
    let res = await build(', scheduled_for');
    if (res.error) res = await build('');
    if (res.error) throw res.error;
    const data = res.data as unknown as Row[] | null;
    const total = res.count ?? null;

    // "Show more": just the next page — the headline numbers are already on screen.
    if (offset > 0) {
      return NextResponse.json({ requests: await withNames(supabase, data ?? []), total: null });
    }

    // Headline counts + daily series (exact per-day counts — reading the
    // rows was capped at 1000 by the API and under-counted busy weeks).
    const now = Date.now();
    const todayStart = localDayStart(now, tz);
    const seriesStart = todayStart - (DAYS - 1) * DAY_MS;
    const dayCount = (i: number) =>
      supabase
        .from('callback_requests')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .gte('requested_at', new Date(seriesStart + i * DAY_MS).toISOString())
        .lt('requested_at', new Date(seriesStart + (i + 1) * DAY_MS).toISOString())
        .then((r) => r.count ?? 0);
    const [perDay, { count: open }, { count: priority }] = await Promise.all([
      Promise.all(Array.from({ length: DAYS }, (_, i) => dayCount(i))),
      supabase
        .from('callback_requests')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .neq('status', 'done'),
      supabase
        .from('callback_requests')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .neq('status', 'done')
        .eq('priority', 'high'),
    ]);
    const daily = Array.from({ length: DAYS }, (_, i) => ({
      date: new Date(seriesStart + i * DAY_MS - tz * 60_000).toISOString().slice(0, 10),
      count: perDay[i],
    }));
    const today = perDay[DAYS - 1];
    const { count: handledToday } = await supabase
      .from('callback_requests')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .in('status', ['called', 'done'])
      .gte('handled_at', new Date(todayStart).toISOString());

    return NextResponse.json({
      requests: await withNames(supabase, data ?? []),
      total,
      stats: { open: open ?? 0, priority: priority ?? 0, today, handled_today: handledToday ?? 0 },
      daily,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
