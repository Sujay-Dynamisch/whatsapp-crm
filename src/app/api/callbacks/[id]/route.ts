// ============================================================
// PATCH /api/callbacks/[id]   { status?, note? }   (migration 058)
// Work a callback request: Called / No answer / Done (+ a short note).
// Done also removes the contact's `callback_requested` tag, so a later
// request opens a fresh one. Agents and up.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { UUID_RE } from '@/lib/journeys/api';

const STATUSES = ['new', 'called', 'no_answer', 'done'] as const;

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as { status?: string; note?: string };

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status as (typeof STATUSES)[number])) {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
      }
      update.status = body.status;
      update.handled_by = body.status === 'new' ? null : userId;
      update.handled_at = body.status === 'new' ? null : new Date().toISOString();
    }
    if (body.note !== undefined) update.note = String(body.note).slice(0, 500) || null;

    const { data: row, error } = await supabase
      .from('callback_requests')
      .update(update)
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id, contact_id, status, note, handled_at, handled_by')
      .maybeSingle();
    if (error) {
      // Re-opening while the contact already has another open request.
      if (error.code === '23505') {
        return NextResponse.json({ error: 'This contact already has an open callback request' }, { status: 409 });
      }
      throw error;
    }
    if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

    if (row.status === 'done') {
      const { data: tag } = await supabase
        .from('tags')
        .select('id')
        .eq('account_id', accountId)
        .ilike('name', 'callback_requested')
        .limit(1)
        .maybeSingle();
      if (tag) await supabase.from('contact_tags').delete().eq('contact_id', row.contact_id).eq('tag_id', tag.id);
    }
    return NextResponse.json({ request: row });
  } catch (error) {
    return toErrorResponse(error);
  }
}
