// ============================================================
// GET /api/health (feature 'failed_messages', migration 060)
// Is the scheduler running, is the website lead feed working, and how
// much is waiting on the Failed messages page. Drives the warning banner.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { STALE_TICK_MS, TICK_HEARTBEAT } from '@/lib/health/health';

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const now = Date.now();
    const [{ data: beat }, { data: sources }, { count: skipped }] = await Promise.all([
      supabase.from('system_heartbeats').select('last_at').eq('name', TICK_HEARTBEAT).maybeSingle(),
      supabase.from('lead_sync_sources').select('enabled, last_run_at, last_report').eq('account_id', accountId),
      supabase.from('lead_sync_issues').select('id', { count: 'exact', head: true }).eq('account_id', accountId).is('resolved', null),
    ]);
    const lastTick = beat?.last_at ? Date.parse(beat.last_at as string) : null;
    const feeds = ((sources ?? []) as { enabled: boolean; last_run_at: string | null; last_report: { error?: string } | null }[]).filter((s) => s.enabled);
    const feedError = feeds.map((s) => s.last_report?.error).find(Boolean) ?? null;
    return NextResponse.json({
      scheduler: {
        last_at: beat?.last_at ?? null,
        // Unknown until the first tick after migration 060 — not an alarm.
        ok: lastTick === null ? null : now - lastTick < STALE_TICK_MS,
      },
      lead_feed: feeds.length === 0 ? { state: 'off', error: null } : { state: feedError ? 'failing' : 'ok', error: feedError },
      skipped_registrations: skipped ?? 0,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
