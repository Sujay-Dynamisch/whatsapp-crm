// GET/PATCH /api/webinars/settings — timing rules (migration 097).

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { loadWebinarRules } from '@/lib/journeys/webinar';
import { TIME_RE, requireWebinarAccess } from '@/lib/webinars/server';

const RANGES: Record<string, [number, number]> = {
  weekday_cutoff_min: [0, 2880],
  weekday_msg2_min: [0, 2880],
  weekday_msg3_min: [0, 1440],
  weekend_cutoff_min: [0, 2880],
  weekend_msg2_min: [0, 2880],
  weekend_msg3_min: [0, 1440],
  checkin_hour: [0, 23],
};

export async function GET() {
  try {
    const { admin, accountId } = await requireWebinarAccess('view');
    return NextResponse.json({ rules: await loadWebinarRules(admin, accountId) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { admin, accountId } = await requireWebinarAccess('edit');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const row: Record<string, unknown> = { account_id: accountId, updated_at: new Date().toISOString() };
    for (const [k, [min, max]] of Object.entries(RANGES)) {
      if (body[k] === undefined) continue;
      const n = Number(body[k]);
      if (!Number.isInteger(n) || n < min || n > max) {
        return NextResponse.json({ error: `${k} must be between ${min} and ${max}` }, { status: 400 });
      }
      row[k] = n;
    }
    for (const k of ['default_weekday_time', 'default_weekend_time']) {
      if (body[k] === undefined) continue;
      if (typeof body[k] !== 'string' || !TIME_RE.test(body[k] as string)) {
        return NextResponse.json({ error: 'Enter times as HH:MM' }, { status: 400 });
      }
      row[k] = body[k];
    }
    const { error } = await admin.from('webinar_settings').upsert(row, { onConflict: 'account_id' });
    if (error) throw error;
    return NextResponse.json({ rules: await loadWebinarRules(admin, accountId) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
