// ============================================================
// POST /api/whatsapp/broadcast/[id]/schedule/retry   (migration 043)
//
// Re-runs a failed (or completed-with-failures) scheduled broadcast
// now, through Cloud Tasks rather than this server.
// Body: { scope?: 'pending' | 'failed' | 'all' }  (default 'all')
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { retryScheduledBroadcast, type RetryScope } from '@/lib/broadcast-scheduling/schedule';
import { scheduleErrorResponse, schedulingServices } from '@/lib/broadcast-scheduling/http';

const SCOPES: RetryScope[] = ['pending', 'failed', 'all'];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`broadcast-schedule:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const scope: RetryScope = SCOPES.includes(body?.scope) ? body.scope : 'all';
    const { backend } = schedulingServices();

    const result = await retryScheduledBroadcast(supabase, backend, {
      accountId,
      broadcastId: id,
      scope,
    });
    return NextResponse.json({ success: true, scope, ...result }, { status: 202 });
  } catch (error) {
    const mapped = scheduleErrorResponse(error);
    if (mapped) return mapped;
    console.error('Error in broadcast schedule retry POST:', error);
    return toErrorResponse(error);
  }
}
