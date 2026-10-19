// ============================================================
// GET /api/journeys/[id]/stats   (migration 050)
// Per-node "entered" counts and per-slot exit counts for the canvas,
// plus enrollment totals by status.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { UUID_RE } from '@/lib/journeys/api';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    const { data: journey } = await supabase
      .from('journeys')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!journey) return NextResponse.json({ error: 'Journey not found' }, { status: 404 });

    const { data: rows, error } = await supabase.rpc('journey_stats', { p_journey_id: id });
    if (error) throw error;

    const nodes: Record<string, { entered: number; failed: number; exits: Record<string, number> }> = {};
    for (const r of (rows ?? []) as { node_id: string; event: string; total: number }[]) {
      const n = (nodes[r.node_id] ??= { entered: 0, failed: 0, exits: {} });
      const total = Number(r.total);
      if (r.event === 'entered') n.entered += total;
      else if (r.event === 'failed') n.failed += total;
      else if (r.event.startsWith('exit:')) n.exits[r.event.slice(5)] = total;
    }

    const { data: enr } = await supabase
      .from('journey_enrollments')
      .select('status')
      .eq('journey_id', id)
      .limit(10000);
    const byStatus: Record<string, number> = {};
    for (const e of enr ?? []) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;

    return NextResponse.json({ nodes, enrollments: byStatus });
  } catch (error) {
    return toErrorResponse(error);
  }
}
