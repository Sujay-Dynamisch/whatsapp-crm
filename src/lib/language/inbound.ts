// ============================================================
// Inbound language pipeline (migration 049) — called by the WhatsApp
// webhook right after a customer message is stored, before the AI
// auto-reply runs (so the AI sees voice-note transcripts).
//
//   voice note → Whisper transcript (+ short summary when long)
//   text / transcript → detect language → translate into the agents'
//                       language → conversation.customer_language
//
// Best effort: never throws; every failure is logged and recorded on
// the message where useful (transcript_status = 'failed').
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { loadAiConfig } from '@/lib/ai/config';
import type { AiConfig } from '@/lib/ai/types';
import { loadDisabledFeatures } from '@/lib/features-server';
import { isFeatureEnabled } from '@/lib/features';
import { decrypt } from '@/lib/whatsapp/encryption';
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api';

import { DEFAULT_LANGUAGE_SETTINGS, type TranscriptionProviderChoice } from './settings';
import { transcribeAudio, type TranscriptionProvider } from './transcribe';
import { summarizeTranscript, translateText } from './translate';

/** Transcripts longer than this many words also get a summary. */
export const SUMMARY_MIN_WORDS = 40;

export interface StoredLanguageSettings {
  agent_language: string;
  translate_inbound: boolean;
  transcribe_voice: boolean;
  summarize_voice: boolean;
  transcription_provider: TranscriptionProviderChoice;
  transcription_api_key: string | null;
}

export async function loadLanguageSettings(
  db: SupabaseClient,
  accountId: string
): Promise<StoredLanguageSettings> {
  const { data } = await db
    .from('language_settings')
    .select(
      'agent_language, translate_inbound, transcribe_voice, summarize_voice, transcription_provider, transcription_api_key'
    )
    .eq('account_id', accountId)
    .maybeSingle();
  const { has_transcription_key: _omit, ...defaults } = DEFAULT_LANGUAGE_SETTINGS;
  void _omit;
  return { ...defaults, transcription_api_key: null, ...(data ?? {}) } as StoredLanguageSettings;
}

/**
 * Which Whisper endpoint + key to use, or null when none is available.
 * 'auto' reuses the AI agent's key if its provider has Whisper (OpenAI,
 * Groq), else falls back to a dedicated transcription key (Groq).
 */
export function resolveTranscriber(
  settings: Pick<StoredLanguageSettings, 'transcription_provider' | 'transcription_api_key'>,
  ai: Pick<AiConfig, 'provider' | 'apiKey'> | null,
  decryptKey: (v: string) => string = decrypt
): { provider: TranscriptionProvider; apiKey: string } | null {
  const ownKey = settings.transcription_api_key ? decryptKey(settings.transcription_api_key) : null;
  const aiWhisper = ai && (ai.provider === 'openai' || ai.provider === 'groq') ? ai.provider : null;

  const provider: TranscriptionProvider | null =
    settings.transcription_provider === 'auto'
      ? (aiWhisper ?? (ownKey ? 'groq' : null))
      : settings.transcription_provider;
  if (!provider) return null;

  const apiKey = ownKey ?? (ai && ai.provider === provider ? ai.apiKey : null);
  return apiKey ? { provider, apiKey } : null;
}

export interface InboundForLanguage {
  type: string;
  audio?: { id?: string; mime_type?: string };
}

export async function processInboundLanguage(
  db: SupabaseClient,
  args: {
    accountId: string;
    conversationId: string;
    messageRowId: string;
    message: InboundForLanguage;
    /** Text already parsed from the message (null for media). */
    text: string | null;
    /** Decrypted WhatsApp token, to fetch voice notes from Meta. */
    accessToken: string;
  }
): Promise<{ transcript: string | null }> {
  let transcript: string | null = null;
  try {
    const disabled = await loadDisabledFeatures(db, args.accountId);
    const canTranscribe = isFeatureEnabled(disabled, 'voice_transcription');
    const canTranslate = isFeatureEnabled(disabled, 'translation');
    const isVoice = args.message.type === 'audio' && Boolean(args.message.audio?.id);
    if (!(isVoice && canTranscribe) && !(args.text?.trim() && canTranslate)) return { transcript };

    const settings = await loadLanguageSettings(db, args.accountId);
    const ai = await loadAiConfig(db, args.accountId, { requireActive: false }).catch(() => null);

    // 1. Voice note → transcript (+ summary)
    if (isVoice && canTranscribe && settings.transcribe_voice) {
      transcript = await transcribeVoice(db, args, settings, ai);
    }

    // 2. Detect + translate
    const source = (args.text?.trim() || transcript || '').trim();
    if (source && canTranslate && settings.translate_inbound && ai) {
      const t = await translateText({ config: ai, text: source, target: settings.agent_language });
      await db
        .from('messages')
        .update({ detected_language: t.language, translated_text: t.translation })
        .eq('id', args.messageRowId);
      if (t.language) {
        await db
          .from('conversations')
          .update({ customer_language: t.language })
          .eq('id', args.conversationId);
      }
    }
  } catch (err) {
    console.error('[language] inbound processing failed:', err instanceof Error ? err.message : err);
  }
  return { transcript };
}

async function transcribeVoice(
  db: SupabaseClient,
  args: Parameters<typeof processInboundLanguage>[1],
  settings: StoredLanguageSettings,
  ai: AiConfig | null
): Promise<string | null> {
  const transcriber = resolveTranscriber(settings, ai);
  if (!transcriber) {
    await db.from('messages').update({ transcript_status: 'skipped' }).eq('id', args.messageRowId);
    return null;
  }
  try {
    const media = await getMediaUrl({ mediaId: args.message.audio!.id!, accessToken: args.accessToken });
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: media.url,
      accessToken: args.accessToken,
    });
    const text = await transcribeAudio({
      ...transcriber,
      audio: buffer,
      mimeType: args.message.audio?.mime_type || contentType,
    });

    let summary: string | null = null;
    if (
      text &&
      settings.summarize_voice &&
      ai &&
      text.split(/\s+/).filter(Boolean).length >= SUMMARY_MIN_WORDS
    ) {
      summary = await summarizeTranscript({
        config: ai,
        transcript: text,
        target: settings.agent_language,
      }).catch(() => null);
    }

    await db
      .from('messages')
      .update({ transcript: text || null, transcript_summary: summary, transcript_status: 'done' })
      .eq('id', args.messageRowId);
    return text || null;
  } catch (err) {
    console.error('[language] transcription failed:', err instanceof Error ? err.message : err);
    await db.from('messages').update({ transcript_status: 'failed' }).eq('id', args.messageRowId);
    return null;
  }
}
