// ============================================================
// GET /api/journeys/[id]/runs/[runId]   (migration 054)
// One run: its context (step outputs, variables) and every event with
// the data each step produced — the execution view.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { UUID_RE } from '@/lib/journeys/api';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { id, runId } = await params;
    if (!UUID_RE.test(id) || !UUID_RE.test(runId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    const { data: run, error } = await supabase
      .from('journey_enrollments')
      .select('id, contact_id, status, current_node_id, steps_taken, last_error, context, entered_at, completed_at, next_run_at, contacts(name, phone)')
      .eq('id', runId)
      .eq('journey_id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw error;
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

    const { data: events } = await supabase
      .from('journey_events')
      .select('id, node_id, event, detail, data, created_at')
      .eq('enrollment_id', runId)
      .order('id', { ascending: true })
      .limit(1000);

    // Every message this run sent and what happened to it (migration 056).
    const { data: messages } = await supabase
      .from('journey_messages')
      .select('id, node_id, kind, template_name, content_text, status, error_code, error_title, error_details, attempt, parent_id, retry_until, next_retry_at, resolved, created_at, updated_at')
      .eq('enrollment_id', runId)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .limit(500);

    const c = (Array.isArray(run.contacts) ? run.contacts[0] : run.contacts) as { name?: string; phone?: string } | null;
    return NextResponse.json({
      run: { ...run, contacts: undefined, contact_name: c?.name ?? null, contact_phone: c?.phone ?? null },
      events: events ?? [],
      messages: messages ?? [],
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
