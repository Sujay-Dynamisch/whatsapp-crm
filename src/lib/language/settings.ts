// Per-account language settings (language_settings, migration 049).
// Pure — client-safe. The encrypted transcription key never appears
// here; the API reports only `has_transcription_key`.

import { isSupportedLanguage } from './languages';

export type TranscriptionProviderChoice = 'auto' | 'openai' | 'groq';

export interface LanguageSettings {
  agent_language: string;
  translate_inbound: boolean;
  transcribe_voice: boolean;
  summarize_voice: boolean;
  transcription_provider: TranscriptionProviderChoice;
  has_transcription_key: boolean;
}

export const DEFAULT_LANGUAGE_SETTINGS: LanguageSettings = {
  agent_language: 'en',
  translate_inbound: true,
  transcribe_voice: true,
  summarize_voice: true,
  transcription_provider: 'auto',
  has_transcription_key: false,
};

export interface LanguageSettingsPatch {
  agent_language: string;
  translate_inbound: boolean;
  transcribe_voice: boolean;
  summarize_voice: boolean;
  transcription_provider: TranscriptionProviderChoice;
  /** undefined = keep, null = clear, string = set */
  transcription_api_key?: string | null;
}

export function parseLanguageSettings(
  body: unknown
): { ok: true; value: LanguageSettingsPatch } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const lang = b.agent_language ?? DEFAULT_LANGUAGE_SETTINGS.agent_language;
  if (!isSupportedLanguage(lang)) return { ok: false, error: 'agent_language is not a supported language' };

  const bool = (key: keyof LanguageSettings): boolean | Error => {
    const v = b[key];
    if (v === undefined) return DEFAULT_LANGUAGE_SETTINGS[key] as boolean;
    return typeof v === 'boolean' ? v : new Error(`${key} must be true or false`);
  };
  const flags = {
    translate_inbound: bool('translate_inbound'),
    transcribe_voice: bool('transcribe_voice'),
    summarize_voice: bool('summarize_voice'),
  };
  for (const v of Object.values(flags)) if (v instanceof Error) return { ok: false, error: v.message };

  const provider = b.transcription_provider ?? 'auto';
  if (provider !== 'auto' && provider !== 'openai' && provider !== 'groq') {
    return { ok: false, error: 'transcription_provider must be auto, openai or groq' };
  }

  let key: string | null | undefined;
  if (b.transcription_api_key === null || b.transcription_api_key === '') key = null;
  else if (typeof b.transcription_api_key === 'string') key = b.transcription_api_key.trim();
  else if (b.transcription_api_key !== undefined) {
    return { ok: false, error: 'transcription_api_key must be a string' };
  }

  return {
    ok: true,
    value: {
      agent_language: lang,
      translate_inbound: flags.translate_inbound as boolean,
      transcribe_voice: flags.transcribe_voice as boolean,
      summarize_voice: flags.summarize_voice as boolean,
      transcription_provider: provider,
      ...(key !== undefined ? { transcription_api_key: key } : {}),
    },
  };
}
