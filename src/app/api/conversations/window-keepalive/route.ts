// ============================================================
// /api/conversations/window-keepalive   (migration 044)
//
//   GET  the account's 24h-window keep-alive settings (any member)
//   PUT  save them (admin)
//
// The sending itself runs in the `windowKeepalive` Cloud Function.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  DEFAULT_KEEPALIVE_SETTINGS,
  parseKeepaliveSettings,
} from '@/lib/conversations/window-keepalive-settings';

const COLUMNS = 'enabled, lead_minutes, quiet_minutes, message_text';

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('window_keepalive_settings')
      .select(COLUMNS)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json({ settings: data ?? DEFAULT_KEEPALIVE_SETTINGS });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const parsed = parseKeepaliveSettings(await request.json().catch(() => ({})));
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('window_keepalive_settings')
      .upsert(
        { account_id: accountId, ...parsed.value, updated_by: userId },
        { onConflict: 'account_id' }
      )
      .select(COLUMNS)
      .single();
    if (error) {
      console.error('[window-keepalive] save failed:', error.message);
      return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
    }
    return NextResponse.json({ settings: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
