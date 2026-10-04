// ============================================================
// /api/whatsapp/broadcast/[id]/schedule   (migration 043)
//
//   POST    schedule, or reschedule, an existing broadcast whose
//           recipients are already planned ('pending').
//           Body: { local_datetime: "2026-10-05T09:30", timezone?: "Asia/Kolkata" }
//              or { scheduled_at: "2026-10-05T09:30:00+05:30", timezone?: ... }
//   DELETE  cancel the schedule.
//
// Creates / removes the Google Cloud Scheduler job (or, inside the
// 2-minute lead window, the Cloud Task directly). Runs with the
// caller's RLS-scoped Supabase client; Google credentials stay in
// server env.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { cancelBroadcastSchedule, scheduleBroadcast } from '@/lib/broadcast-scheduling/schedule';
import {
  parseScheduleBody,
  scheduleErrorResponse,
  schedulingServices,
} from '@/lib/broadcast-scheduling/http';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Scheduling puts real messages on real phones later — same gate as sending now.
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`broadcast-schedule:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const { scheduledAt, timezone } = parseScheduleBody(await request.json().catch(() => ({})));
    const { cfg, backend } = schedulingServices();

    const result = await scheduleBroadcast(supabase, backend, cfg, {
      accountId,
      broadcastId: id,
      scheduledAt,
      timezone,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const mapped = scheduleErrorResponse(error);
    if (mapped) return mapped;
    console.error('Error in broadcast schedule POST:', error);
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;
    const { backend } = schedulingServices();

    const result = await cancelBroadcastSchedule(supabase, backend, {
      accountId,
      broadcastId: id,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const mapped = scheduleErrorResponse(error);
    if (mapped) return mapped;
    console.error('Error in broadcast schedule DELETE:', error);
    return toErrorResponse(error);
  }
}
