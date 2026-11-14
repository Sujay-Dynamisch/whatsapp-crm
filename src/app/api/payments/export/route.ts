// ============================================================
// GET /api/payments/export   (admins / owners)
// CSV of every recorded payment across all callers (migration 095),
// one row per payment, plus leads with a price but nothing paid yet.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { loadTracking } from '@/lib/payments/tracking';

const METHOD: Record<string, string> = { upi: 'UPI', card: 'Card', netbanking: 'Net banking', cash: 'Cash', other: 'Other' };

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formulas; quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const tracking = await loadTracking(supabase, accountId);
    if (!tracking) return NextResponse.json({ error: 'not_enabled' }, { status: 404 });
    const db = supabaseAdmin();

    const [{ data: plans }, { data: inst }, { data: records }] = await Promise.all([
      db.from('payment_plans').select('contact_id, total_price, plan').eq('account_id', accountId).limit(20000),
      db
        .from('payment_installments')
        .select('contact_id, amount, method, paid_on, note, created_by, updated_by, created_at')
        .eq('account_id', accountId)
        .order('paid_on', { ascending: true })
        .limit(50000),
      db.from('payment_records').select('contact_id').eq('account_id', accountId).limit(20000),
    ]);

    const contactIds = [...new Set([...(plans ?? []), ...(inst ?? [])].map((r) => r.contact_id as string))];
    const contacts = new Map<string, { name: string | null; phone: string; caller: string | null }>();
    for (let i = 0; i < contactIds.length; i += 500) {
      const { data } = await db.from('contacts').select('id, name, phone, assigned_caller_id').in('id', contactIds.slice(i, i + 500));
      for (const c of data ?? []) contacts.set(c.id as string, { name: c.name as string | null, phone: c.phone as string, caller: c.assigned_caller_id as string | null });
    }
    const people = new Set<string>();
    for (const c of contacts.values()) if (c.caller) people.add(c.caller);
    for (const r of inst ?? []) for (const u of [r.created_by, r.updated_by]) if (u) people.add(u as string);
    const { data: profs } = people.size ? await db.from('profiles').select('user_id, full_name, email').in('user_id', [...people]) : { data: [] };
    const nameOf = new Map((profs ?? []).map((p) => [p.user_id as string, (p.full_name as string) || (p.email as string) || '']));

    const planOf = new Map((plans ?? []).map((p) => [p.contact_id as string, { total: Number(p.total_price), plan: p.plan as string }]));
    const paidSet = new Set((records ?? []).map((r) => r.contact_id as string));
    const received = new Map<string, number>();
    for (const r of inst ?? []) received.set(r.contact_id as string, (received.get(r.contact_id as string) ?? 0) + Number(r.amount));

    const header = [
      'Lead', 'Phone', 'Caller', 'Payment type', `Full price (${tracking.currency})`, 'Payment #',
      `Amount (${tracking.currency})`, 'Method', 'Paid on', 'Note', 'Recorded by',
      `Total received (${tracking.currency})`, `Balance (${tracking.currency})`, 'Status',
    ];
    const rows: unknown[][] = [];
    const seq = new Map<string, number>();
    const leadCols = (id: string) => {
      const c = contacts.get(id);
      const p = planOf.get(id);
      const got = Math.round((received.get(id) ?? 0) * 100) / 100;
      const balance = p ? Math.max(0, Math.round((p.total - got) * 100) / 100) : '';
      const status = paidSet.has(id) ? 'Paid' : got > 0 ? 'Part paid' : 'Not paid';
      return { c, p, got, balance, status };
    };
    for (const r of inst ?? []) {
      const id = r.contact_id as string;
      const n = (seq.get(id) ?? 0) + 1;
      seq.set(id, n);
      const { c, p, got, balance, status } = leadCols(id);
      rows.push([
        c?.name ?? '', c?.phone ?? '', c?.caller ? nameOf.get(c.caller) ?? '' : 'Unassigned',
        p ? (p.plan === 'advance' ? 'Advance' : 'Full') : '', p?.total ?? '', n,
        Number(r.amount), METHOD[r.method as string] ?? r.method ?? '', r.paid_on, r.note ?? '',
        nameOf.get((r.updated_by ?? r.created_by) as string) ?? '', got, balance, status,
      ]);
    }
    // Priced leads with no payment yet.
    for (const [id] of planOf) {
      if (seq.has(id)) continue;
      const { c, p, got, balance, status } = leadCols(id);
      rows.push([
        c?.name ?? '', c?.phone ?? '', c?.caller ? nameOf.get(c.caller) ?? '' : 'Unassigned',
        p?.plan === 'advance' ? 'Advance' : 'Full', p?.total ?? '', '', '', '', '', '', '', got, balance, status,
      ]);
    }

    const csv = '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="payments-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
