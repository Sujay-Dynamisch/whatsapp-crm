// ============================================================
// Shared bits for the Next.js scheduling routes.
// ============================================================

import { NextResponse } from 'next/server';

import { readSchedulingConfig, SchedulingNotConfiguredError, type SchedulingConfig } from './config';
import { createGcpBackend, type SchedulingBackend } from './gcp-backend';
import { ScheduleError } from './schedule';
import { DEFAULT_BROADCAST_TIMEZONE, isValidTimeZone, zonedLocalToUtc } from './time';

export function schedulingServices(): { cfg: SchedulingConfig; backend: SchedulingBackend } {
  const cfg = readSchedulingConfig();
  return { cfg, backend: createGcpBackend(cfg) };
}

/** Maps scheduling errors to JSON responses; null for anything else. */
export function scheduleErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof ScheduleError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  if (error instanceof SchedulingNotConfiguredError) {
    console.error('[broadcast-scheduling]', error.message);
    return NextResponse.json(
      {
        error: 'Scheduled broadcasts are not configured on this server.',
        code: 'scheduling_not_configured',
      },
      { status: 503 }
    );
  }
  return null;
}

const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Accepts either
 *   { local_datetime: "2026-10-05T09:30", timezone?: "Asia/Kolkata" }  — wall clock in tz
 *   { scheduled_at: "2026-10-05T04:00:00Z", timezone?: ... }          — absolute instant
 * Timezone defaults to Asia/Kolkata.
 */
export function parseScheduleBody(body: unknown): { scheduledAt: Date; timezone: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const timezone =
    typeof b.timezone === 'string' && b.timezone.trim() ? b.timezone.trim() : DEFAULT_BROADCAST_TIMEZONE;
  if (!isValidTimeZone(timezone)) {
    throw new ScheduleError('invalid_timezone', `Unknown time zone "${timezone}"`, 400);
  }

  if (typeof b.local_datetime === 'string' && b.local_datetime.trim()) {
    try {
      return { scheduledAt: zonedLocalToUtc(b.local_datetime, timezone), timezone };
    } catch (err) {
      throw new ScheduleError('invalid_time', (err as Error).message, 400);
    }
  }
  if (typeof b.scheduled_at === 'string' && b.scheduled_at.trim()) {
    // Without an explicit offset, Date() would read it in the SERVER's
    // zone — silently wrong for every user not co-located with it.
    if (!OFFSET_RE.test(b.scheduled_at.trim())) {
      throw new ScheduleError(
        'invalid_time',
        'scheduled_at must include a UTC offset (e.g. 2026-10-05T09:30:00+05:30). For wall-clock input use local_datetime + timezone.',
        400
      );
    }
    const scheduledAt = new Date(b.scheduled_at);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new ScheduleError('invalid_time', 'scheduled_at is not a valid date', 400);
    }
    return { scheduledAt, timezone };
  }
  throw new ScheduleError('invalid_time', 'Provide local_datetime (+ timezone) or scheduled_at', 400);
}
