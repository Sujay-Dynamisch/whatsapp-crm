// ============================================================
// GET /api/whatsapp/quality[?refresh=1]   (migration 048)
//
// The WhatsApp number's quality rating + messaging tier, and what the
// broadcast quality guard will do with it. `refresh=1` asks Meta now
// instead of using the hourly cache.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { checkQualityGuard, refreshQuality } from '@/lib/smart-sending/quality';

export async function GET(request: Request) {
  try {
    const { accountId } = await getCurrentAccount();
    // Service role: refreshing writes whatsapp_config, which agents and
    // viewers can't. Every query below is scoped to the caller's account.
    const db = supabaseAdmin();

    let refreshError: string | null = null;
    if (new URL(request.url).searchParams.get('refresh') === '1') {
      await refreshQuality(db, accountId).catch((err: unknown) => {
        refreshError = err instanceof Error ? err.message : 'Refresh failed';
      });
    }

    const guard = await checkQualityGuard(db, accountId);
    const { data: cfg } = await db
      .from('whatsapp_config')
      .select('quality_checked_at, quality_event, quality_event_at')
      .eq('account_id', accountId)
      .maybeSingle();

    return NextResponse.json({
      rating: guard.rating,
      tier: guard.tier,
      action: guard.action,
      guardEnabled: guard.settings.quality_guard,
      checkedAt: cfg?.quality_checked_at ?? null,
      lastEvent: cfg?.quality_event ?? null,
      lastEventAt: cfg?.quality_event_at ?? null,
      refreshError,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
