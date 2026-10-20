// ============================================================
// POST /api/journeys/[id]/test-step   { node, run_id?, trigger? }
// (migration 054). Runs one step against the data of an earlier run
// (`run_id`, else the latest run) or against sample trigger data, and
// returns what it would output. Nothing is sent or written; HTTP and
// code steps do execute, so this needs an agent and is rate limited.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit } from '@/lib/rate-limit';
import { UUID_RE } from '@/lib/journeys/api';
import { NODE_TYPES, type JourneyNode } from '@/lib/journeys/graph';
import { emptyScope, type ExprScope } from '@/lib/journeys/expressions';
import { loadContact, scopeFromContext } from '@/lib/journeys/engine';
import { previewStep } from '@/lib/journeys/test-step';

export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    const limit = checkRateLimit(`journey-test:${accountId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) {
      return NextResponse.json({ error: 'Too many test runs — wait a minute' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    const node = body?.node as JourneyNode | undefined;
    if (!node || typeof node !== 'object' || !NODE_TYPES.includes(node.type) || typeof node.config !== 'object') {
      return NextResponse.json({ error: 'Invalid step' }, { status: 400 });
    }

    const { data: journey } = await supabase
      .from('journeys')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!journey) return NextResponse.json({ error: 'Journey not found' }, { status: 404 });

    // Data to test against: a chosen run, the latest run, or nothing.
    let run = null as null | { id: string; contact_id: string; account_id: string; context: Record<string, unknown> };
    let q = supabase
      .from('journey_enrollments')
      .select('id, contact_id, account_id, context')
      .eq('journey_id', id)
      .eq('account_id', accountId);
    q = typeof body?.run_id === 'string' && UUID_RE.test(body.run_id) ? q.eq('id', body.run_id) : q.order('entered_at', { ascending: false });
    const { data: runs } = await q.limit(1);
    run = (runs?.[0] as typeof run) ?? null;

    let scope: ExprScope = emptyScope();
    if (run) {
      scope = scopeFromContext(run.context ?? {}, await loadContact(supabase, run), new Date());
    }
    if (body?.trigger && typeof body.trigger === 'object' && !Array.isArray(body.trigger)) {
      scope = { ...scope, trigger: body.trigger as Record<string, unknown> };
    }

    const preview = await previewStep(node, scope);
    return NextResponse.json({ ...preview, run_id: run?.id ?? null });
  } catch (error) {
    return toErrorResponse(error);
  }
}
