// ============================================================
// GET /api/trash?kind=callback|payment   (migration 100)
// Deleted callback requests / payment entries. Admins only.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { listTrash } from '@/lib/trash/server';

export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('admin');
    const kind = new URL(request.url).searchParams.get('kind');
    if (kind !== 'callback' && kind !== 'payment') return NextResponse.json({ error: 'Invalid kind' }, { status: 400 });
    return NextResponse.json({ items: await listTrash(supabaseAdmin(), accountId, kind) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
