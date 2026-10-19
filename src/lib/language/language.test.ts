import { afterEach, describe, expect, it, vi } from 'vitest';

import { isSupportedLanguage, languageName, normalizeLanguage } from './languages';
import { parseTranslationReply } from './translate';
import { MAX_AUDIO_BYTES, transcribeAudio, TRANSCRIPTION_ENDPOINTS } from './transcribe';
import { parseLanguageSettings } from './settings';
import { resolveTranscriber } from './inbound';

afterEach(() => vi.unstubAllGlobals());

describe('languages', () => {
  it('normalises codes', () => {
    expect(normalizeLanguage('hi-IN')).toBe('hi');
    expect(normalizeLanguage(' MR ')).toBe('mr');
    expect(normalizeLanguage('pt_BR')).toBe('pt');
    expect(normalizeLanguage('hindi language')).toBeNull();
    expect(normalizeLanguage(42)).toBeNull();
  });

  it('names languages, falling back to the code', () => {
    expect(languageName('ta')).toBe('Tamil');
    expect(languageName('sw')).toBe('SW');
    expect(languageName(null)).toBe('');
    expect(isSupportedLanguage('mr')).toBe(true);
    expect(isSupportedLanguage('xx')).toBe(false);
  });
});

describe('parseTranslationReply', () => {
  it('reads plain JSON', () => {
    expect(parseTranslationReply('{"language":"hi","translation":"I want the price"}')).toEqual({
      language: 'hi',
      text: 'I want the price',
    });
  });

  it('tolerates code fences and chatter around the JSON', () => {
    expect(
      parseTranslationReply('Sure!\n```json\n{"language": "mr-IN", "translation": "Hello"}\n```')
    ).toEqual({ language: 'mr', text: 'Hello' });
  });

  it('rejects replies without a usable translation', () => {
    expect(parseTranslationReply('I cannot do that')).toBeNull();
    expect(parseTranslationReply('{"language":"hi"}')).toBeNull();
    expect(parseTranslationReply('{not json}')).toBeNull();
  });
});

describe('transcribeAudio', () => {
  it('posts the voice note to Whisper as multipart form data', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: ' नमस्ते ' })));
    vi.stubGlobal('fetch', fetchMock);

    const text = await transcribeAudio({
      provider: 'groq',
      apiKey: 'gsk_test',
      audio: Buffer.from('OggS...'),
      mimeType: 'audio/ogg; codecs=opus',
    });
    expect(text).toBe('नमस्ते');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TRANSCRIPTION_ENDPOINTS.groq.url);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk_test');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3');
    const file = form.get('file') as File;
    expect(file.name).toBe('voice.ogg');
    expect(file.type).toBe('audio/ogg');
  });

  it('refuses files over the Whisper limit without calling out', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      transcribeAudio({
        provider: 'openai',
        apiKey: 'k',
        audio: Buffer.alloc(MAX_AUDIO_BYTES + 1),
        mimeType: 'audio/ogg',
      })
    ).rejects.toThrow(/25 MB/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the provider error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 }))
    );
    await expect(
      transcribeAudio({ provider: 'groq', apiKey: 'bad', audio: Buffer.from('x'), mimeType: 'audio/ogg' })
    ).rejects.toThrow('groq transcription failed (401): Invalid API Key');
  });
});

describe('parseLanguageSettings', () => {
  it('accepts valid settings and key changes', () => {
    const r = parseLanguageSettings({
      agent_language: 'hi',
      translate_inbound: false,
      transcription_provider: 'groq',
      transcription_api_key: ' gsk_abc ',
    });
    expect(r).toEqual({
      ok: true,
      value: {
        agent_language: 'hi',
        translate_inbound: false,
        transcribe_voice: true,
        summarize_voice: true,
        transcription_provider: 'groq',
        transcription_api_key: 'gsk_abc',
      },
    });
    const clear = parseLanguageSettings({ transcription_api_key: '' });
    expect(clear.ok && clear.value.transcription_api_key).toBeNull();
    const keep = parseLanguageSettings({});
    expect(keep.ok && 'transcription_api_key' in keep.value).toBe(false);
  });

  it('rejects bad input', () => {
    expect(parseLanguageSettings({ agent_language: 'xx' }).ok).toBe(false);
    expect(parseLanguageSettings({ translate_inbound: 'yes' }).ok).toBe(false);
    expect(parseLanguageSettings({ transcription_provider: 'azure' }).ok).toBe(false);
    expect(parseLanguageSettings({ transcription_api_key: 5 }).ok).toBe(false);
  });
});

describe('resolveTranscriber', () => {
  const dec = (v: string) => `dec(${v})`;
  const auto = { transcription_provider: 'auto' as const, transcription_api_key: null };

  it('auto reuses the AI key when the AI provider has Whisper', () => {
    expect(resolveTranscriber(auto, { provider: 'groq', apiKey: 'gk' }, dec)).toEqual({
      provider: 'groq',
      apiKey: 'gk',
    });
    expect(resolveTranscriber(auto, { provider: 'openai', apiKey: 'ok' }, dec)).toEqual({
      provider: 'openai',
      apiKey: 'ok',
    });
  });

  it('auto falls back to a dedicated Groq key for other AI providers', () => {
    expect(resolveTranscriber(auto, { provider: 'gemini', apiKey: 'g' }, dec)).toBeNull();
    expect(
      resolveTranscriber({ ...auto, transcription_api_key: 'enc' }, { provider: 'gemini', apiKey: 'g' }, dec)
    ).toEqual({ provider: 'groq', apiKey: 'dec(enc)' });
  });

  it('an explicit provider needs a matching key', () => {
    const groq = { transcription_provider: 'groq' as const, transcription_api_key: null };
    expect(resolveTranscriber(groq, { provider: 'openai', apiKey: 'ok' }, dec)).toBeNull();
    expect(resolveTranscriber(groq, null, dec)).toBeNull();
  });
});
