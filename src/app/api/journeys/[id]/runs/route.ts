// ============================================================
// GET /api/journeys/[id]/runs?status=   (migration 054)
// Recent runs (enrollments) of a journey for the run history panel.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { UUID_RE } from '@/lib/journeys/api';
import { fetchAll } from '@/lib/supabase/fetch-all';

const STATUSES = ['active', 'waiting', 'completed', 'exited', 'failed'];
/** Runs per page in Run history ("Load more" asks for the next). */
const RUNS_PAGE = 50;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const params_ = new URL(request.url).searchParams;
    const status = params_.get('status');
    const offset = Math.max(0, Math.floor(Number(params_.get('offset')) || 0));
    // Contact name/phone search; strip PostgREST filter syntax characters.
    const search = (params_.get('q') ?? '').replace(/[^\p{L}\p{N} +@.\-_]/gu, '').trim();

    let q = supabase
      .from('journey_enrollments')
      .select(
        `id, contact_id, status, current_node_id, steps_taken, last_error, entered_at, completed_at, updated_at, contacts${search ? '!inner' : ''}(name, phone)`
      )
      .eq('journey_id', id)
      .eq('account_id', accountId)
      .order('entered_at', { ascending: false })
      .order('id')
      .range(offset, offset + RUNS_PAGE); // one extra row tells the page there is more
    if (status && STATUSES.includes(status)) q = q.eq('status', status);
    if (search) q = q.or(`name.ilike.%${search}%,phone.ilike.%${search}%`, { referencedTable: 'contacts' });

    const { data: rows, error } = await q;
    if (error) throw error;
    const hasMore = (rows ?? []).length > RUNS_PAGE;
    const data = (rows ?? []).slice(0, RUNS_PAGE);

    // Message outcome counts per run (migration 056) for the list badges.
    const ids = (data ?? []).map((r) => r.id);
    const counts = new Map<string, { sent: number; delivered: number; read: number; failed: number }>();
    if (ids.length) {
      const msgs = await fetchAll((lo, hi) =>
        supabase
          .from('journey_messages')
          .select('enrollment_id, status, resolved')
          .eq('account_id', accountId)
          .in('enrollment_id', ids)
          .order('id')
          .range(lo, hi)
      );
      for (const m of (msgs ?? []) as { enrollment_id: string; status: string; resolved: string | null }[]) {
        const c = counts.get(m.enrollment_id) ?? { sent: 0, delivered: 0, read: 0, failed: 0 };
        // A failed message that was later retried / re-sent counts via its follow-up.
        if (m.status === 'failed' && m.resolved && m.resolved !== 'expired') continue;
        if (m.status in c) c[m.status as keyof typeof c]++;
        counts.set(m.enrollment_id, c);
      }
    }

    return NextResponse.json({
      hasMore,
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
