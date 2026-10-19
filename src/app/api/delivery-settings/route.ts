// ============================================================
// /api/delivery-settings   (migration 048, feature 'smart_sending')
//   GET  any member · PUT admin
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  DEFAULT_DELIVERY_SETTINGS,
  parseDeliverySettings,
} from '@/lib/smart-sending/settings';

const COLUMNS =
  'auto_retry_limited, retry_delay_hours, rest_days, rest_after_unread, quality_guard, yellow_pass_size';

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('delivery_settings')
      .select(COLUMNS)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json({ settings: { ...DEFAULT_DELIVERY_SETTINGS, ...(data ?? {}) } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const parsed = parseDeliverySettings(await request.json().catch(() => ({})));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const { data, error } = await supabase
      .from('delivery_settings')
      .upsert({ account_id: accountId, ...parsed.value, updated_by: userId }, { onConflict: 'account_id' })
      .select(COLUMNS)
      .single();
    if (error) {
      console.error('[delivery-settings] save failed:', error.message);
      return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
    }
    return NextResponse.json({ settings: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
