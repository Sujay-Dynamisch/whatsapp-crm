// ============================================================
// GET /api/journeys/[id]/runs?status=   (migration 054)
// Recent runs (enrollments) of a journey for the run history panel.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { UUID_RE } from '@/lib/journeys/api';

const STATUSES = ['active', 'waiting', 'completed', 'exited', 'failed'];

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const status = new URL(request.url).searchParams.get('status');

    let q = supabase
      .from('journey_enrollments')
      .select(
        'id, contact_id, status, current_node_id, steps_taken, last_error, entered_at, completed_at, updated_at, contacts(name, phone)'
      )
      .eq('journey_id', id)
      .eq('account_id', accountId)
      .order('entered_at', { ascending: false })
      .limit(50);
    if (status && STATUSES.includes(status)) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw error;
    return NextResponse.json({
      runs: (data ?? []).map((r) => {
        const c = (Array.isArray(r.contacts) ? r.contacts[0] : r.contacts) as { name?: string; phone?: string } | null;
        return { ...r, contacts: undefined, contact_name: c?.name ?? null, contact_phone: c?.phone ?? null };
      }),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
