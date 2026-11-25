// ============================================================
// PATCH  /api/conversions/[id]  { amount?, caller_id?, converted_at?, note? }
// DELETE /api/conversions/[id]  — un-converts (removes the "customer" tag)
// Admins and owners only (migration 104). Writes use the service role;
// every query is pinned to the admin's own account.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { UUID_RE } from '@/lib/journeys/api';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requireRole('admin');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as {
      amount?: number | string | null;
      caller_id?: string | null;
      converted_at?: string;
      note?: string | null;
    };
    const db = supabaseAdmin();
    const update: Record<string, unknown> = { updated_at: new Date().toISOString(), edited_at: new Date().toISOString() };

    if (body.amount !== undefined) {
      if (body.amount === null || body.amount === '') update.amount = null;
      else {
        const n = Number(body.amount);
        if (!Number.isFinite(n) || n < 0) return NextResponse.json({ error: 'Amount must be 0 or more' }, { status: 400 });
        update.amount = Math.round(n * 100) / 100;
      }
    }
    if (body.caller_id !== undefined) {
      if (body.caller_id !== null) {
        if (!UUID_RE.test(body.caller_id)) return NextResponse.json({ error: 'Invalid caller' }, { status: 400 });
        const { data: member } = await db.from('profiles').select('user_id').eq('user_id', body.caller_id).eq('account_id', accountId).maybeSingle();
        if (!member) return NextResponse.json({ error: 'That person is not in this workspace' }, { status: 400 });
      }
      update.caller_id = body.caller_id;
    }
    if (body.converted_at !== undefined) {
      const t = Date.parse(body.converted_at);
      if (Number.isNaN(t) || t > Date.now() + 864e5) return NextResponse.json({ error: 'Invalid date' }, { status: 400 });
      update.converted_at = new Date(t).toISOString();
    }
    if (body.note !== undefined) update.note = body.note ? String(body.note).trim().slice(0, 500) || null : null;

    const { data, error } = await db.from('conversions').update(update).eq('id', id).eq('account_id', accountId).select('id').maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requireRole('admin');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const db = supabaseAdmin();
    const { data: row, error } = await db.from('conversions').delete().eq('id', id).eq('account_id', accountId).select('contact_id').maybeSingle();
    if (error) throw error;
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { data: tag } = await db.from('tags').select('id').eq('account_id', accountId).ilike('name', 'customer').limit(1).maybeSingle();
    if (tag) await db.from('contact_tags').delete().eq('contact_id', row.contact_id).eq('tag_id', tag.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
