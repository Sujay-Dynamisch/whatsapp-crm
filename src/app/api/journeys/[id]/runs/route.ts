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

    // Message outcome counts per run (migration 056) for the list badges.
    const ids = (data ?? []).map((r) => r.id);
    const counts = new Map<string, { sent: number; delivered: number; read: number; failed: number }>();
    if (ids.length) {
      const { data: msgs } = await supabase
        .from('journey_messages')
        .select('enrollment_id, status, resolved')
        .eq('account_id', accountId)
        .in('enrollment_id', ids)
        .limit(5000);
      for (const m of (msgs ?? []) as { enrollment_id: string; status: string; resolved: string | null }[]) {
        const c = counts.get(m.enrollment_id) ?? { sent: 0, delivered: 0, read: 0, failed: 0 };
        // A failed message that was later retried / re-sent counts via its follow-up.
        if (m.status === 'failed' && m.resolved && m.resolved !== 'expired') continue;
        if (m.status in c) c[m.status as keyof typeof c]++;
        counts.set(m.enrollment_id, c);
      }
    }

    return NextResponse.json({
      runs: (data ?? []).map((r) => {
        const c = (Array.isArray(r.contacts) ? r.contacts[0] : r.contacts) as { name?: string; phone?: string } | null;
        return {
          ...r,
          contacts: undefined,
          contact_name: c?.name ?? null,
          contact_phone: c?.phone ?? null,
          messages: counts.get(r.id) ?? null,
        };
      }),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
