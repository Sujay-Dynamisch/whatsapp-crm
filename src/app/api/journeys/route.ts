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

    // Counted per PERSON, not per run: a callback follow-up or a re-entry
    // starts a new run for the same contact. A paying lead's run ends
    // 'completed' (engine PAID_TAG_NAMES), so this matches the Run history
    // filter exactly. Counted in the database (migration 106); before it is
    // applied, falls back to reading the runs page by page.
    const ids = (journeys ?? []).map((j) => j.id);
    const stats = new Map<string, { in_progress: number; completed: number; failed: number; total: number }>();
    const { data: agg, error: aggErr } = ids.length
      ? await supabase.rpc('journey_people_stats', { p_journey_ids: ids })
      : { data: [], error: null };
    if (!aggErr) {
      for (const r of (agg ?? []) as { journey_id: string; total: number; in_progress: number; completed: number; failed: number }[]) {
        stats.set(r.journey_id, {
          in_progress: Number(r.in_progress),
          completed: Number(r.completed),
          failed: Number(r.failed),
          total: Number(r.total),
        });
      }
    } else {
      for (const id of ids) {
        const people = new Map<string, Set<string>>();
        for (let from = 0; ; from += 1000) {
          const { data: rows, error: runErr } = await supabase
            .from('journey_enrollments')
            .select('contact_id, status')
            .eq('journey_id', id)
            .order('id')
            .range(from, from + 999);
          if (runErr) throw runErr;
          for (const r of rows ?? []) {
            const set = people.get(r.contact_id) ?? new Set<string>();
            set.add(r.status);
            people.set(r.contact_id, set);
          }
          if (!rows || rows.length < 1000) break;
        }
        const s = { in_progress: 0, completed: 0, failed: 0, total: people.size };
        for (const statuses of people.values()) {
          if (statuses.has('completed')) s.completed++;
          else if (statuses.has('active') || statuses.has('waiting')) s.in_progress++;
          else if (statuses.has('failed')) s.failed++;
        }
        stats.set(id, s);
      }
    }
    return NextResponse.json({
      journeys: (journeys ?? []).map((j) => ({
        ...j,
        stats: stats.get(j.id) ?? { in_progress: 0, completed: 0, failed: 0, total: 0 },
      })),
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
