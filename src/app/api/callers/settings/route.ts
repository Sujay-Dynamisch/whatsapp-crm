// ============================================================
// GET/PATCH /api/callers/settings — callback reminder policy + AI
// callback-detection threshold (migration 087). Callers area.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { DEFAULT_POLICY } from '@/lib/callbacks/followups';
import { requireCallersAccess } from '@/lib/callers/server';

const DEFAULTS = { ...DEFAULT_POLICY, ai_detection_enabled: true, ai_confidence_threshold: 0.75 };
type Settings = typeof DEFAULTS;

const INT_RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  priority_initial_min: [1, 10080],
  priority_repeat_min: [5, 10080],
  priority_max_reminders: [0, 50],
  standard_initial_min: [1, 10080],
  standard_repeat_min: [5, 10080],
  standard_max_reminders: [0, 50],
  window_start_hour: [0, 23],
  window_end_hour: [1, 24],
};

export async function GET() {
  try {
    const { admin, accountId } = await requireCallersAccess('view');
    const { data } = await admin.from('callback_settings').select('*').eq('account_id', accountId).maybeSingle();
    return NextResponse.json({ settings: { ...DEFAULTS, ...(data ?? {}) } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { admin, accountId } = await requireCallersAccess('edit');
    const body = (await request.json().catch(() => ({}))) as Partial<Record<keyof Settings, unknown>>;
    const row: Record<string, unknown> = { account_id: accountId, updated_at: new Date().toISOString() };

    for (const [key, [min, max]] of Object.entries(INT_RANGES) as [keyof Settings, [number, number]][]) {
      if (body[key] === undefined) continue;
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < min || n > max) {
        return NextResponse.json({ error: `${key} must be a whole number between ${min} and ${max}` }, { status: 400 });
      }
      row[key] = n;
    }
    if (body.window_days !== undefined) {
      const days = Array.isArray(body.window_days) ? [...new Set(body.window_days.map(Number))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7) : [];
      if (!days.length) return NextResponse.json({ error: 'Pick at least one reminder day' }, { status: 400 });
      row.window_days = days.sort();
    }
    if (body.escalate_to !== undefined) {
      if (body.escalate_to !== 'admins' && body.escalate_to !== 'none') return NextResponse.json({ error: 'Invalid escalation' }, { status: 400 });
      row.escalate_to = body.escalate_to;
    }
    for (const key of ['repeat_until_handled', 'ai_detection_enabled'] as const) {
      if (body[key] !== undefined) row[key] = body[key] === true;
    }
    if (body.ai_confidence_threshold !== undefined) {
      const t = Number(body.ai_confidence_threshold);
      if (!(t >= 0.3 && t <= 1)) return NextResponse.json({ error: 'Confidence threshold must be between 0.30 and 1.00' }, { status: 400 });
      row.ai_confidence_threshold = Math.round(t * 100) / 100;
    }
    if (typeof body.timezone === 'string' && body.timezone.trim()) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: body.timezone.trim() });
        row.timezone = body.timezone.trim();
      } catch {
        return NextResponse.json({ error: 'Unknown timezone' }, { status: 400 });
      }
    }

    const { data: current } = await admin.from('callback_settings').select('window_start_hour, window_end_hour').eq('account_id', accountId).maybeSingle();
    const start = Number(row.window_start_hour ?? current?.window_start_hour ?? DEFAULTS.window_start_hour);
    const end = Number(row.window_end_hour ?? current?.window_end_hour ?? DEFAULTS.window_end_hour);
    if (end <= start) return NextResponse.json({ error: 'Reminder end hour must be after the start hour' }, { status: 400 });

    const { data, error } = await admin.from('callback_settings').upsert(row, { onConflict: 'account_id' }).select('*').single();
    if (error) throw error;
    return NextResponse.json({ settings: { ...DEFAULTS, ...data } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
