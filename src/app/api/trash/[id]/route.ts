// ============================================================
// /api/trash/[id]   (migration 100) — admins only
//   POST    restore the item exactly as it was
//   DELETE  delete it forever
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { UUID_RE } from '@/lib/journeys/api';
import { TrashError, purgeTrash, restoreTrash } from '@/lib/trash/server';

type Params = { params: Promise<{ id: string }> };

function handle(err: unknown) {
  if (err instanceof TrashError) return NextResponse.json({ error: err.message }, { status: err.status });
  return toErrorResponse(err);
}

export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const { data: profile } = await supabase.from('profiles').select('full_name').eq('user_id', userId).maybeSingle();
    const who = (profile?.full_name as string | null)?.trim() || 'an admin';
    const r = await restoreTrash(supabaseAdmin(), { accountId, userId, trashId: id, who });
    return NextResponse.json({ ok: true, kind: r.kind });
  } catch (error) {
    return handle(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { accountId } = await requireRole('admin');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    await purgeTrash(supabaseAdmin(), { accountId, trashId: id });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handle(error);
  }
}
