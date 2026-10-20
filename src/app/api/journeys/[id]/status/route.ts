// ============================================================
// POST /api/journeys/[id]/status   { status: 'active' | 'paused' }
// (migration 050). Activation requires a fully valid graph. Pausing
// leaves enrollments where they are; they exit when next woken.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { scheduleColumn, UUID_RE, validateGraph } from '@/lib/journeys/api';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const body = await request.json().catch(() => ({}));
    const status = body?.status;
    if (status !== 'active' && status !== 'paused') {
      return NextResponse.json({ error: "status must be 'active' or 'paused'" }, { status: 400 });
    }

    const { data: journey } = await supabase
      .from('journeys')
      .select('graph, status')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!journey) return NextResponse.json({ error: 'Journey not found' }, { status: 404 });

    if (status === 'active') {
      const issues = validateGraph(journey.graph);
      if (issues.length > 0) {
        return NextResponse.json({ error: 'Fix these before activating', issues }, { status: 400 });
      }
    }

    const { error } = await supabase
      .from('journeys')
      .update({
        status,
        ...(status === 'active' ? { activated_at: new Date().toISOString() } : {}),
        // A schedule journey books its first run on activation.
        ...scheduleColumn(journey.graph, status),
      })
      .eq('id', id)
      .eq('account_id', accountId);
    if (error) return NextResponse.json({ error: 'Failed to update journey' }, { status: 500 });
    return NextResponse.json({ success: true, status });
  } catch (error) {
    return toErrorResponse(error);
  }
}
