// ============================================================
// GET  /api/payments?status=pending|paid|closed|all&q=&tz=   (migration 063)
// POST /api/payments  { contact_id, amount?, method?, note? }
//
// The Payments module for accounts with a payment_tracking row: leads
// who were sent the payment link, who paid and who is not proceeding.
// POST marks a lead as paid — saves the record, adds the paid tag and
// stops their waiting journey runs that exit on it. Agents and up.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { UUID_RE } from '@/lib/journeys/api';
import { ensureTag, loadTracking, stopRunsExitingOnTag, tagIdsByName } from '@/lib/payments/tracking';

type Status = 'pending' | 'paid' | 'closed';
const DAY_MS = 864e5;

interface Lead {
  contact_id: string;
  status: Status;
  link_sent_at: string | null;
  paid_at: string | null;
  amount: number | null;
  method: string | null;
  note: string | null;
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const tracking = await loadTracking(supabase, accountId);
    if (!tracking) return NextResponse.json({ error: 'not_enabled' }, { status: 404 });

    const p = new URL(request.url).searchParams;
    const want = p.get('status') ?? 'pending';
    const search = (p.get('q') ?? '').trim().toLowerCase();
    const tz = Math.max(-840, Math.min(840, Number(p.get('tz')) || 0));

    const ids = await tagIdsByName(supabase, accountId, [tracking.pending_tag, tracking.paid_tag, tracking.closed_tag]);
    const pendingId = ids.get(tracking.pending_tag.toLowerCase());
    const paidId = ids.get(tracking.paid_tag.toLowerCase());
    const closedId = ids.get(tracking.closed_tag.toLowerCase());
    const tagIds = [pendingId, paidId, closedId].filter((x): x is string => !!x);

    const [links, records] = await Promise.all([
      tagIds.length
        ? supabase.from('contact_tags').select('contact_id, tag_id, created_at').in('tag_id', tagIds).limit(5000)
        : Promise.resolve({ data: [] }),
      supabase
        .from('payment_records')
        .select('contact_id, amount, method, note, paid_at')
        .eq('account_id', accountId)
        .limit(5000),
    ]);

    const leads = new Map<string, Lead>();
    const lead = (id: string) => {
      let r = leads.get(id);
      if (!r) {
        r = { contact_id: id, status: 'pending', link_sent_at: null, paid_at: null, amount: null, method: null, note: null };
        leads.set(id, r);
      }
      return r;
    };
    const paidSet = new Set<string>();
    const closedSet = new Set<string>();
    for (const l of (links.data ?? []) as { contact_id: string; tag_id: string; created_at: string }[]) {
      const r = lead(l.contact_id);
      if (l.tag_id === pendingId) r.link_sent_at = l.created_at;
      if (l.tag_id === paidId) {
        paidSet.add(l.contact_id);
        r.paid_at ??= l.created_at;
      }
      if (l.tag_id === closedId) closedSet.add(l.contact_id);
    }
    for (const rec of (records.data ?? []) as { contact_id: string; amount: number | null; method: string | null; note: string | null; paid_at: string }[]) {
      const r = lead(rec.contact_id);
      paidSet.add(rec.contact_id);
      Object.assign(r, { paid_at: rec.paid_at, amount: rec.amount, method: rec.method, note: rec.note });
    }
    for (const [id, r] of leads) {
      r.status = paidSet.has(id) ? 'paid' : closedSet.has(id) ? 'closed' : 'pending';
      // Closed leads only matter here if they were sent the payment link.
      if (r.status === 'closed' && !r.link_sent_at) leads.delete(id);
    }

    // Contact details + whether a journey is still sending them messages.
    const contactIds = [...leads.keys()];
    const contacts = new Map<string, { name: string | null; phone: string | null }>();
    const running = new Map<string, string | null>();
    for (let i = 0; i < contactIds.length; i += 500) {
      const chunk = contactIds.slice(i, i + 500);
      const [cs, runs] = await Promise.all([
        supabase.from('contacts').select('id, name, phone').eq('account_id', accountId).in('id', chunk),
        supabase
          .from('journey_enrollments')
          .select('contact_id, next_run_at')
          .eq('account_id', accountId)
          .eq('status', 'waiting')
          .in('contact_id', chunk),
      ]);
      for (const c of (cs.data ?? []) as { id: string; name: string | null; phone: string | null }[]) contacts.set(c.id, c);
      for (const e of (runs.data ?? []) as { contact_id: string; next_run_at: string | null }[]) running.set(e.contact_id, e.next_run_at);
    }

    const all = [...leads.values()]
      .filter((r) => contacts.has(r.contact_id))
      .map((r) => ({
        ...r,
        contact_name: contacts.get(r.contact_id)?.name ?? null,
        contact_phone: contacts.get(r.contact_id)?.phone ?? null,
        in_journey: running.has(r.contact_id),
        next_message_at: running.get(r.contact_id) ?? null,
      }));

    const local = Date.now() - tz * 60_000;
    const todayStart = local - (((local % DAY_MS) + DAY_MS) % DAY_MS) + tz * 60_000;
    const paid = all.filter((r) => r.status === 'paid');
    const stats = {
      pending: all.filter((r) => r.status === 'pending').length,
      paid: paid.length,
      closed: all.filter((r) => r.status === 'closed').length,
      paid_today: paid.filter((r) => r.paid_at && Date.parse(r.paid_at) >= todayStart).length,
      amount_total: paid.reduce((s, r) => s + (Number(r.amount) || 0), 0),
      currency: tracking.currency,
    };

    const list = all
      .filter((r) => want === 'all' || r.status === want)
      .filter(
        (r) =>
          !search ||
          (r.contact_name ?? '').toLowerCase().includes(search) ||
          (r.contact_phone ?? '').toLowerCase().includes(search)
      )
      .sort((a, b) => {
        const ta = Date.parse((a.status === 'paid' ? a.paid_at : a.link_sent_at) ?? '') || 0;
        const tb = Date.parse((b.status === 'paid' ? b.paid_at : b.link_sent_at) ?? '') || 0;
        return tb - ta;
      })
      .slice(0, 500);

    return NextResponse.json({ leads: list, stats });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const tracking = await loadTracking(supabase, accountId);
    if (!tracking) return NextResponse.json({ error: 'not_enabled' }, { status: 404 });

    const body = (await request.json().catch(() => ({}))) as {
      contact_id?: string;
      amount?: number | string | null;
      method?: string | null;
      note?: string | null;
    };
    if (!body.contact_id || !UUID_RE.test(body.contact_id)) {
      return NextResponse.json({ error: 'contact_id is required' }, { status: 400 });
    }
    const amount = body.amount === null || body.amount === undefined || body.amount === '' ? null : Number(body.amount);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      return NextResponse.json({ error: 'Amount must be a positive number' }, { status: 400 });
    }

    const db = supabaseAdmin();
    // RLS client: a scoped caller (086) can only mark their own leads.
    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', body.contact_id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

    const now = new Date();
    const { error } = await db.from('payment_records').upsert(
      {
        account_id: accountId,
        contact_id: body.contact_id,
        amount,
        method: body.method?.toString().slice(0, 40) || null,
        note: body.note?.toString().slice(0, 500) || null,
        paid_at: now.toISOString(),
        marked_by: userId,
      },
      { onConflict: 'contact_id' }
    );
    if (error) throw error;

    const paidTagId = await ensureTag(db, accountId, userId, tracking.paid_tag);
    await db
      .from('contact_tags')
      .upsert({ contact_id: body.contact_id, tag_id: paidTagId }, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true });

    const { data: profile } = await supabase.from('profiles').select('full_name').eq('user_id', userId).maybeSingle();
    const who = (profile?.full_name as string | null)?.trim() || 'a team member';
    const stopped = await stopRunsExitingOnTag(db, {
      accountId,
      contactId: body.contact_id,
      tagId: paidTagId,
      reason: `Marked as paid by ${who}`,
      now,
    });
    return NextResponse.json({ paid: true, journeys_stopped: stopped });
  } catch (error) {
    return toErrorResponse(error);
  }
}
