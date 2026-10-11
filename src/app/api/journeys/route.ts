// ============================================================
// /api/journeys   (migration 050)
//   GET   list with enrollment counts (any member)
//   POST  create { name } with a starter graph (agent+)
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { starterGraph } from '@/lib/journeys/graph';
import { triggerColumns } from '@/lib/journeys/api';

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data: journeys, error } = await supabase
      .from('journeys')
      .select('id, name, description, status, trigger_type, activated_at, updated_at, created_at')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false });
    if (error) throw error;

    const ids = (journeys ?? []).map((j) => j.id);
    const counts: Record<string, Record<string, number>> = {};
    for (let i = 0; i < ids.length; i += 50) {
      const { data: rows } = await supabase
        .from('journey_enrollments')
        .select('journey_id, status')
        .in('journey_id', ids.slice(i, i + 50))
        .limit(10000);
      for (const r of rows ?? []) {
        counts[r.journey_id] ??= {};
        counts[r.journey_id][r.status] = (counts[r.journey_id][r.status] ?? 0) + 1;
      }
    }

    return NextResponse.json({
      journeys: (journeys ?? []).map((j) => {
        const c = counts[j.id] ?? {};
        return {
          ...j,
          stats: {
            in_progress: (c.active ?? 0) + (c.waiting ?? 0),
            completed: c.completed ?? 0,
            failed: c.failed ?? 0,
            total: Object.values(c).reduce((a, b) => a + b, 0),
          },
        };
      }),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) {
      return NextResponse.json({ error: 'Give the journey a name (up to 120 characters)' }, { status: 400 });
    }
    const graph = starterGraph();
    const { data, error } = await supabase
      .from('journeys')
      .insert({
        account_id: accountId,
        name,
        description: typeof body?.description === 'string' ? body.description.slice(0, 500) : null,
        graph,
        ...triggerColumns(graph),
        created_by: userId,
      })
      .select('id')
      .single();
    if (error) {
      console.error('[journeys] create failed:', error.message);
      return NextResponse.json({ error: 'Failed to create journey' }, { status: 500 });
    }
    return NextResponse.json({ id: data.id }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
