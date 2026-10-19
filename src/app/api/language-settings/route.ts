// ============================================================
// /api/language-settings   (migration 049)
//   GET  any member — never returns the transcription key, only whether set
//   PUT  admin
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  DEFAULT_LANGUAGE_SETTINGS,
  parseLanguageSettings,
  type LanguageSettings,
} from '@/lib/language/settings';

const COLUMNS =
  'agent_language, translate_inbound, transcribe_voice, summarize_voice, transcription_provider, transcription_api_key';

function present(row: Record<string, unknown> | null): LanguageSettings {
  if (!row) return DEFAULT_LANGUAGE_SETTINGS;
  const { transcription_api_key, ...rest } = row;
  return {
    ...DEFAULT_LANGUAGE_SETTINGS,
    ...(rest as Partial<LanguageSettings>),
    has_transcription_key: Boolean(transcription_api_key),
  };
}

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('language_settings')
      .select(COLUMNS)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json({ settings: present(data) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const parsed = parseLanguageSettings(await request.json().catch(() => ({})));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const { transcription_api_key, ...rest } = parsed.value;
    const row: Record<string, unknown> = { account_id: accountId, ...rest, updated_by: userId };
    if (transcription_api_key !== undefined) {
      row.transcription_api_key = transcription_api_key ? encrypt(transcription_api_key) : null;
    }

    const { data, error } = await supabase
      .from('language_settings')
      .upsert(row, { onConflict: 'account_id' })
      .select(COLUMNS)
      .single();
    if (error) {
      console.error('[language-settings] save failed:', error.message);
      return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
    }
    return NextResponse.json({ settings: present(data) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
