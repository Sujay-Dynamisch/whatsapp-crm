import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---- mocks ----------------------------------------------------------
const s = vi.hoisted(() => ({
  disabled: [] as string[],
  ai: { provider: 'groq', apiKey: 'gk', model: 'm' } as Record<string, unknown> | null,
  replies: [] as string[],
  prompts: [] as string[],
  transcript: 'मुझे कल शाम को डिलीवरी चाहिए',
  transcribeError: null as Error | null,
}));

vi.mock('@/lib/features-server', async () => {
  const { isFeatureEnabled } = await import('@/lib/features');
  return {
    loadDisabledFeatures: async () => s.disabled,
    accountHasFeature: async (_db: unknown, _a: string, f: string) =>
      isFeatureEnabled(s.disabled, f as never),
  };
});
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: async () => s.ai }));
vi.mock('@/lib/ai/generate', () => ({
  generateReply: vi.fn(async ({ systemPrompt }: { systemPrompt: string }) => {
    s.prompts.push(systemPrompt);
    return { text: s.replies.shift() ?? '', handoff: false, usage: null };
  }),
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: async () => ({ url: 'https://meta/media/1', mimeType: 'audio/ogg', fileSize: 10 }),
  downloadMedia: async () => ({ buffer: Buffer.from('OggS'), contentType: 'audio/ogg' }),
}));
vi.mock('./transcribe', async (orig) => ({
  ...(await orig<typeof import('./transcribe')>()),
  transcribeAudio: vi.fn(async () => {
    if (s.transcribeError) throw s.transcribeError;
    return s.transcript;
  }),
}));

import { processInboundLanguage } from './inbound';
import { translateOutgoing, TranslationUnavailableError } from './outbound';
import { translateText } from './translate';
import { transcribeAudio } from './transcribe';

// ---- fake db: records updates, serves settings / conversation --------
let updates: { table: string; patch: Record<string, unknown> }[];
let settingsRow: Record<string, unknown> | null;
let convLanguage: string | null;

function db(): SupabaseClient {
  return {
    from(table: string) {
      const b = {
        select: () => b,
        eq: () => b,
        update: (patch: Record<string, unknown>) => (updates.push({ table, patch }), b),
        maybeSingle: async () => ({
          data:
            table === 'language_settings'
              ? settingsRow
              : table === 'conversations'
                ? { customer_language: convLanguage }
                : null,
          error: null,
        }),
        then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const base = {
  accountId: 'acct',
  conversationId: 'conv',
  messageRowId: 'msg',
  accessToken: 'wa-token',
};
const patchesFor = (table: string) => updates.filter((u) => u.table === table).map((u) => u.patch);

beforeEach(() => {
  s.disabled = [];
  s.ai = { provider: 'groq', apiKey: 'gk', model: 'm' };
  s.replies = [];
  s.prompts = [];
  s.transcript = 'मुझे कल शाम को डिलीवरी चाहिए';
  s.transcribeError = null;
  updates = [];
  settingsRow = null;
  convLanguage = null;
  vi.mocked(transcribeAudio).mockClear();
});

describe('translateText', () => {
  it('returns the translation and detected language', async () => {
    s.replies = ['{"language":"hi","translation":"I need delivery tomorrow evening"}'];
    const r = await translateText({ config: s.ai as never, text: 'kal shaam delivery chahiye', target: 'en' });
    expect(r).toEqual({ language: 'hi', translation: 'I need delivery tomorrow evening' });
    expect(s.prompts[0]).toContain('English (en)');
  });

  it('returns no translation when the text is already in the target language', async () => {
    s.replies = ['{"language":"en","translation":"Hello"}'];
    expect(await translateText({ config: s.ai as never, text: 'Hello', target: 'en' })).toEqual({
      language: 'en',
      translation: null,
    });
  });

  it('throws on an unparseable model reply', async () => {
    s.replies = ['Sorry, I cannot help with that'];
    await expect(translateText({ config: s.ai as never, text: 'x', target: 'en' })).rejects.toThrow(/JSON/);
  });
});

describe('processInboundLanguage', () => {
  it('translates a text message and records the customer language', async () => {
    s.replies = ['{"language":"mr","translation":"What is the price?"}'];
    const out = await processInboundLanguage(db(), {
      ...base,
      message: { type: 'text' },
      text: 'किंमत काय आहे?',
    });
    expect(out.transcript).toBeNull();
    expect(patchesFor('messages')).toEqual([
      { detected_language: 'mr', translated_text: 'What is the price?' },
    ]);
    expect(patchesFor('conversations')).toEqual([{ customer_language: 'mr' }]);
  });

  it('transcribes a voice note, summarises a long one, then translates it', async () => {
    s.transcript = Array.from({ length: 45 }, () => 'शब्द').join(' ');
    s.replies = [
      'Customer wants delivery tomorrow evening.', // summary
      '{"language":"hi","translation":"words words"}', // translation
    ];
    const out = await processInboundLanguage(db(), {
      ...base,
      message: { type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus' } },
      text: null,
    });
    expect(out.transcript).toBe(s.transcript);
    expect(vi.mocked(transcribeAudio)).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'groq', apiKey: 'gk', mimeType: 'audio/ogg; codecs=opus' })
    );
    expect(patchesFor('messages')).toEqual([
      {
        transcript: s.transcript,
        transcript_summary: 'Customer wants delivery tomorrow evening.',
        transcript_status: 'done',
      },
      { detected_language: 'hi', translated_text: 'words words' },
    ]);
  });

  it('does not summarise short voice notes', async () => {
    s.replies = ['{"language":"hi","translation":"I need delivery tomorrow evening"}'];
    await processInboundLanguage(db(), {
      ...base,
      message: { type: 'audio', audio: { id: 'media-1' } },
      text: null,
    });
    expect(patchesFor('messages')[0]).toMatchObject({ transcript_summary: null, transcript_status: 'done' });
  });

  it('marks a voice note skipped when no Whisper key is available', async () => {
    s.ai = { provider: 'gemini', apiKey: 'g', model: 'm' };
    s.replies = [];
    await processInboundLanguage(db(), {
      ...base,
      message: { type: 'audio', audio: { id: 'media-1' } },
      text: null,
    });
    expect(patchesFor('messages')).toEqual([{ transcript_status: 'skipped' }]);
    expect(vi.mocked(transcribeAudio)).not.toHaveBeenCalled();
  });

  it('records a failed transcription and never throws', async () => {
    s.transcribeError = new Error('groq transcription failed (429)');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await processInboundLanguage(db(), {
      ...base,
      message: { type: 'audio', audio: { id: 'media-1' } },
      text: null,
    });
    expect(out.transcript).toBeNull();
    expect(patchesFor('messages')).toEqual([{ transcript_status: 'failed' }]);
    err.mockRestore();
  });

  it('respects the admin feature switches', async () => {
    s.disabled = ['translation', 'voice_transcription'];
    await processInboundLanguage(db(), { ...base, message: { type: 'text' }, text: 'hola' });
    await processInboundLanguage(db(), {
      ...base,
      message: { type: 'audio', audio: { id: 'media-1' } },
      text: null,
    });
    expect(updates).toEqual([]);
    expect(s.prompts).toEqual([]);
  });

  it('respects the account settings toggles', async () => {
    settingsRow = { agent_language: 'en', translate_inbound: false, transcribe_voice: false };
    await processInboundLanguage(db(), { ...base, message: { type: 'text' }, text: 'hola' });
    await processInboundLanguage(db(), {
      ...base,
      message: { type: 'audio', audio: { id: 'media-1' } },
      text: null,
    });
    expect(updates).toEqual([]);
  });
});

describe('translateOutgoing', () => {
  it('translates into the customer language and keeps the original', async () => {
    convLanguage = 'ta';
    s.replies = ['{"language":"en","translation":"நன்றி"}'];
    expect(await translateOutgoing(db(), { accountId: 'acct', conversationId: 'conv', text: 'Thank you' })).toEqual({
      text: 'நன்றி',
      original: 'Thank you',
      language: 'ta',
    });
    expect(s.prompts[0]).toContain('Tamil (ta)');
  });

  it('sends unchanged when the customer language is unknown or matches the team', async () => {
    convLanguage = null;
    expect((await translateOutgoing(db(), { accountId: 'acct', conversationId: 'conv', text: 'Hi' })).original).toBeNull();
    convLanguage = 'en';
    expect((await translateOutgoing(db(), { accountId: 'acct', conversationId: 'conv', text: 'Hi' })).original).toBeNull();
    expect(s.prompts).toEqual([]);
  });

  it('refuses when translation is switched off or no AI key exists', async () => {
    convLanguage = 'hi';
    s.disabled = ['translation'];
    await expect(
      translateOutgoing(db(), { accountId: 'acct', conversationId: 'conv', text: 'Hi' })
    ).rejects.toBeInstanceOf(TranslationUnavailableError);
    s.disabled = [];
    s.ai = null;
    await expect(
      translateOutgoing(db(), { accountId: 'acct', conversationId: 'conv', text: 'Hi' })
    ).rejects.toThrow(/AI provider key/);
  });
});
