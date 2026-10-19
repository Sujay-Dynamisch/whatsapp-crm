// ============================================================
// POST /api/messages/translate   { message_id }   (migration 049)
//
// Translate one stored customer message on demand (older messages, or
// when automatic inbound translation is off). Saves the result on the
// message so it's only paid for once.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { loadAiConfig } from '@/lib/ai/config';
import { loadLanguageSettings } from '@/lib/language/inbound';
import { translateText } from '@/lib/language/translate';
import { supabaseAdmin } from '@/lib/flows/admin-client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const body = await request.json().catch(() => ({}));
    const messageId = body?.message_id;
    if (typeof messageId !== 'string' || !UUID_RE.test(messageId)) {
      return NextResponse.json({ error: 'message_id is required' }, { status: 400 });
    }

    // Read through the caller's RLS client: proves the message is theirs.
    const { data: msg } = await supabase
      .from('messages')
      .select('id, conversation_id, content_text, transcript, translated_text, detected_language')
      .eq('id', messageId)
      .maybeSingle();
    if (!msg) return NextResponse.json({ error: 'Message not found' }, { status: 404 });

    if (msg.translated_text || msg.detected_language) {
      return NextResponse.json({
        translated_text: msg.translated_text,
        detected_language: msg.detected_language,
      });
    }

    const source = ((msg.content_text as string | null) || (msg.transcript as string | null) || '').trim();
    if (!source) return NextResponse.json({ error: 'Nothing to translate' }, { status: 400 });

    // Writes go through the service role (messages are written by the
    // webhook, not users); the read above already proved ownership.
    const admin = supabaseAdmin();
    const ai = await loadAiConfig(admin, accountId, { requireActive: false });
    if (!ai) {
      return NextResponse.json(
        { error: 'Translation needs an AI provider key — add one under AI Agents → Setup.' },
        { status: 409 }
      );
    }
    const settings = await loadLanguageSettings(admin, accountId);
    const t = await translateText({ config: ai, text: source, target: settings.agent_language });

    await admin
      .from('messages')
      .update({ translated_text: t.translation, detected_language: t.language })
      .eq('id', messageId);
    if (t.language) {
      await admin
        .from('conversations')
        .update({ customer_language: t.language })
        .eq('id', msg.conversation_id as string)
        .eq('account_id', accountId);
    }

    return NextResponse.json({ translated_text: t.translation, detected_language: t.language });
  } catch (error) {
    if (error instanceof Error && error.name === 'AiError') {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    return toErrorResponse(error);
  }
}
