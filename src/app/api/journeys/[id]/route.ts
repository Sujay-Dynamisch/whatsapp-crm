// ============================================================
// /api/journeys/[id]   (migration 050)
//   GET     journey + graph (any member)
//   PUT     save { name?, description?, graph?, allow_reentry? } (agent+)
//   DELETE  (admin)
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  isGraphShape,
  newWebhookToken,
  scheduleColumn,
  triggerColumns,
  UUID_RE,
  validateGraph,
} from '@/lib/journeys/api';

interface Params {
  params: Promise<{ id: string }>;
}

const COLUMNS =
  'id, name, description, status, trigger_type, trigger_config, graph, allow_reentry, activated_at, created_at, updated_at, webhook_token, next_scheduled_at';

export async function GET(_req: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const { data, error } = await supabase
      .from('journeys')
      .select(COLUMNS)
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'Journey not found' }, { status: 404 });
    return NextResponse.json({ journey: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }

    const { data: current } = await supabase
      .from('journeys')
      .select('status, webhook_token')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!current) return NextResponse.json({ error: 'Journey not found' }, { status: 404 });

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 120) {
        return NextResponse.json({ error: 'Name must be 1–120 characters' }, { status: 400 });
      }
      patch.name = name;
    }
    if (body.description !== undefined) {
      patch.description = typeof body.description === 'string' ? body.description.slice(0, 500) : null;
    }
    if (body.allow_reentry !== undefined) patch.allow_reentry = body.allow_reentry === true;
    if (body.graph !== undefined) {
      if (!isGraphShape(body.graph)) {
        return NextResponse.json({ error: 'Invalid journey graph' }, { status: 400 });
      }
      // A live journey must stay runnable — contacts are moving through it.
      if (current.status === 'active') {
        const issues = validateGraph(body.graph);
        if (issues.length > 0) {
          return NextResponse.json(
            { error: 'Fix these before saving an active journey', issues },
            { status: 400 }
          );
        }
      }
      patch.graph = body.graph;
      const trigger = triggerColumns(body.graph);
      Object.assign(patch, trigger, scheduleColumn(body.graph, current.status));
      // The hook URL is stable once issued, so an external system keeps
      // working across edits (and across switching trigger types).
      if (trigger.trigger_type === 'webhook' && !current.webhook_token) patch.webhook_token = newWebhookToken();
    }

    const { data, error } = await supabase
      .from('journeys')
      .update(patch)
      .eq('id', id)
      .eq('account_id', accountId)
      .select(COLUMNS)
      .single();
    if (error) {
      console.error('[journeys] save failed:', error.message);
      return NextResponse.json({ error: 'Failed to save journey' }, { status: 500 });
    }
    return NextResponse.json({ journey: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const { error } = await supabase.from('journeys').delete().eq('id', id).eq('account_id', accountId);
    if (error) return NextResponse.json({ error: 'Failed to delete journey' }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
