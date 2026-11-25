// ============================================================
// GET /api/conversions?range=month|30d|all&q=   (migration 104)
// Leads who paid and became customers. Reads run with the viewer's RLS,
// so callers get only their own leads; admins get everyone plus a
// per-caller breakdown. Edits / deletes live in ./[id] (admins only).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';

interface Row {
  id: string;
  contact_id: string;
  caller_id: string | null;
  amount: number | null;
  source: string;
  note: string | null;
  converted_at: string;
  contacts: { name: string | null; phone: string | null } | { name: string | null; phone: string | null }[] | null;
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId, role, userId } = await getCurrentAccount();
    const isAdmin = hasMinRole(role, 'admin');
    const p = new URL(request.url).searchParams;
    const range = p.get('range') ?? 'all';
    const search = (p.get('q') ?? '').replace(/[^\p{L}\p{N} +@.\-_]/gu, '').trim();

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const from = range === 'month' ? monthStart.toISOString() : range === '30d' ? new Date(Date.now() - 30 * 864e5).toISOString() : null;

    let q = supabase
      .from('conversions')
      .select(`id, contact_id, caller_id, amount, source, note, converted_at, contacts${search ? '!inner' : ''}(name, phone)`)
      .eq('account_id', accountId)
      .order('converted_at', { ascending: false })
      .limit(2000);
    if (from) q = q.gte('converted_at', from);
    if (search) q = q.or(`name.ilike.%${search}%,phone.ilike.%${search}%`, { referencedTable: 'contacts' });

    const [{ data, error }, { data: all }, { count: leads }, { data: people }, { data: tracking }] = await Promise.all([
      q,
      // Headline numbers ignore the range / search filters.
      supabase.from('conversions').select('caller_id, amount, converted_at').eq('account_id', accountId).limit(20000),
      isAdmin
        ? supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('account_id', accountId)
        : supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('account_id', accountId).eq('assigned_caller_id', userId),
      supabase.from('profiles').select('user_id, full_name').eq('account_id', accountId),
      supabase.from('payment_tracking').select('currency').eq('account_id', accountId).maybeSingle(),
    ]);
    if (error) {
      if (/conversions/.test(error.message)) return NextResponse.json({ error: 'not_ready' }, { status: 404 });
      throw error;
    }

    const nameOf = new Map((people ?? []).map((x) => [x.user_id as string, (x.full_name as string) || 'Team member']));
    const rows = ((data ?? []) as unknown as Row[]).map((r) => {
      const c = Array.isArray(r.contacts) ? r.contacts[0] : r.contacts;
      return {
        id: r.id,
        contact_id: r.contact_id,
        name: c?.name ?? null,
        phone: c?.phone ?? null,
        caller_id: r.caller_id,
        caller_name: r.caller_id ? nameOf.get(r.caller_id) ?? 'Team member' : null,
        amount: r.amount === null ? null : Number(r.amount),
        source: r.source,
        note: r.note,
        converted_at: r.converted_at,
      };
    });

    const everything = (all ?? []) as { caller_id: string | null; amount: number | null; converted_at: string }[];
    const total = everything.length;
    const stats = {
      customers: total,
      this_month: everything.filter((r) => Date.parse(r.converted_at) >= monthStart.getTime()).length,
      revenue: everything.reduce((s, r) => s + (Number(r.amount) || 0), 0),
      leads: leads ?? 0,
      rate: leads ? Math.round((total / leads) * 1000) / 10 : 0,
    };

    // Per-caller leaderboard (admins): conversions, revenue and their lead count.
    let byCaller: { caller_id: string | null; name: string; customers: number; revenue: number; leads: number; rate: number }[] = [];
    if (isAdmin) {
      const { data: owned } = await supabase
        .from('contacts')
        .select('assigned_caller_id')
        .eq('account_id', accountId)
        .not('assigned_caller_id', 'is', null)
        .limit(50000);
      const leadCount = new Map<string, number>();
      for (const o of owned ?? []) leadCount.set(o.assigned_caller_id as string, (leadCount.get(o.assigned_caller_id as string) ?? 0) + 1);
      const agg = new Map<string, { customers: number; revenue: number }>();
      for (const r of everything) {
        const k = r.caller_id ?? '';
        const v = agg.get(k) ?? { customers: 0, revenue: 0 };
        v.customers++;
        v.revenue += Number(r.amount) || 0;
        agg.set(k, v);
      }
      for (const k of leadCount.keys()) if (!agg.has(k)) agg.set(k, { customers: 0, revenue: 0 });
      byCaller = [...agg.entries()]
        .map(([k, v]) => {
          const l = k ? leadCount.get(k) ?? 0 : 0;
          return { caller_id: k || null, name: k ? nameOf.get(k) ?? 'Team member' : 'No caller', ...v, leads: l, rate: l ? Math.round((v.customers / l) * 1000) / 10 : 0 };
        })
        .sort((a, b) => b.customers - a.customers || b.revenue - a.revenue);
    }

    return NextResponse.json({
      isAdmin,
      currency: (tracking?.currency as string) || 'INR',
      stats,
      byCaller,
      callers: isAdmin ? [...nameOf.entries()].map(([id, name]) => ({ id, name })) : [],
      conversions: rows,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
