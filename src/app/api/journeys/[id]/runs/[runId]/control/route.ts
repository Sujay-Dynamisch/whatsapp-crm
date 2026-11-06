// ============================================================
// POST /api/journeys/[id]/runs/[runId]/control
//   { action: 'send_now' }                       — end the current wait now
//   { action: 'skip', node_id, skip: boolean }   — skip / un-skip an
//                                                  upcoming message once
// Simple controls for staff in the run history. Only a waiting run can
// be changed (a run executing a step is refused); the engine picks the
// change up on its next tick. Agents and up; writes use the service
// role (only the engine writes enrollments).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { UUID_RE } from '@/lib/journeys/api';
import type { JourneyGraph } from '@/lib/journeys/graph';

const SKIPPABLE = new Set(['send_template', 'send_text', 'send_media', 'send_buttons']);

export async function POST(request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  try {
    const { accountId } = await requireRole('agent');
    const { id, runId } = await params;
    if (!UUID_RE.test(id) || !UUID_RE.test(runId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as { action?: string; node_id?: string; skip?: boolean };

    const db = supabaseAdmin();
    const { data: run } = await db
      .from('journey_enrollments')
      .select('id, status, context, journeys(graph)')
      .eq('id', runId)
      .eq('journey_id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    if (run.status !== 'waiting') {
      return NextResponse.json({ error: 'Only a waiting run can be changed — refresh and try again' }, { status: 409 });
    }

    if (body.action === 'send_now') {
      const { data: updated } = await db
        .from('journey_enrollments')
        .update({ next_run_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', runId)
        .eq('status', 'waiting')
        .select('id');
      if (!updated?.length) return NextResponse.json({ error: 'The run moved on — refresh and try again' }, { status: 409 });
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'skip') {
      const j = (Array.isArray(run.journeys) ? run.journeys[0] : run.journeys) as { graph?: JourneyGraph } | null;
      const node = j?.graph?.nodes.find((n) => n.id === body.node_id);
      if (!node || !SKIPPABLE.has(node.type)) return NextResponse.json({ error: 'That step is not a message' }, { status: 400 });
      const context = (run.context ?? {}) as { skip_nodes?: string[] } & Record<string, unknown>;
      const set = new Set(context.skip_nodes ?? []);
      if (body.skip === false) set.delete(node.id);
      else set.add(node.id);
      const { data: updated } = await db
        .from('journey_enrollments')
        .update({ context: { ...context, skip_nodes: [...set] }, updated_at: new Date().toISOString() })
        .eq('id', runId)
        .eq('status', 'waiting')
        .select('id');
      if (!updated?.length) return NextResponse.json({ error: 'The run moved on — refresh and try again' }, { status: 409 });
      return NextResponse.json({ ok: true, skip_nodes: [...set] });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
