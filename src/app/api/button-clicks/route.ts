// ============================================================
// GET /api/button-clicks?days=30[&broadcast_id=…]   (migration 046)
//
// Summary + recent taps for the Button Clicks tab. Any account member
// may read. Gated by the 'button_analytics' feature (middleware path
// rule + a restrictive RLS policy on button_clicks).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';

const RANGES = [7, 30, 90, 365];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECENT_LIMIT = 100;

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const url = new URL(request.url);

    const daysParam = Number(url.searchParams.get('days') ?? 30);
    const days = RANGES.includes(daysParam) ? daysParam : 30;
    const broadcastId = url.searchParams.get('broadcast_id');
    if (broadcastId && !UUID_RE.test(broadcastId)) {
      return NextResponse.json({ error: 'Invalid broadcast_id' }, { status: 400 });
    }

    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

    const { data: summary, error: summaryErr } = await supabase.rpc('button_click_summary', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
    });
    if (summaryErr) {
      console.error('[button-clicks] summary failed:', summaryErr.message);
      return NextResponse.json({ error: 'Failed to load button clicks' }, { status: 500 });
    }

    let recentQuery = supabase
      .from('button_clicks')
      .select(
        'id, clicked_at, button_text, button_payload, button_kind, card_index, source, template_name, broadcast_id, conversation_id, contact:contacts(id, name, phone), broadcast:broadcasts(id, name)'
      )
      .eq('account_id', accountId)
      .gte('clicked_at', from.toISOString())
      .order('clicked_at', { ascending: false })
      .limit(RECENT_LIMIT);
    if (broadcastId) recentQuery = recentQuery.eq('broadcast_id', broadcastId);

    const { data: recent, error: recentErr } = await recentQuery;
    if (recentErr) {
      console.error('[button-clicks] recent failed:', recentErr.message);
      return NextResponse.json({ error: 'Failed to load button clicks' }, { status: 500 });
    }

    return NextResponse.json({ days, summary, recent: recent ?? [] });
  } catch (error) {
    return toErrorResponse(error);
  }
}
