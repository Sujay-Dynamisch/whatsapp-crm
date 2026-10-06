import { afterEach, describe, expect, it, vi } from 'vitest';

import { AiError, type AiConfig } from '../types';
import { generateReply } from '../generate';
import { AI_PROVIDER_INFO, AI_PROVIDERS } from './registry';
import { generateOpenAiCompatible } from './openai-compatible';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const args = {
  apiKey: 'test-key',
  model: 'llama-3.3-70b-versatile',
  systemPrompt: 'Be brief.',
  messages: [
    { role: 'user' as const, content: 'hi' },
    { role: 'user' as const, content: 'are you there?' },
  ],
  timeoutMs: 5_000,
  baseUrl: 'https://api.groq.com/openai/v1/',
  providerLabel: 'Groq',
};

afterEach(() => vi.unstubAllGlobals());

describe('generateOpenAiCompatible', () => {
  it('posts an OpenAI-shaped chat request to the provider base URL', async () => {
    const fetchMock = vi.fn(async () =>
      ok({
        choices: [{ message: { content: 'Hello!' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await generateOpenAiCompatible(args);
    expect(res).toEqual({
      text: 'Hello!',
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // Trailing slash on the base URL doesn't produce `//chat`.
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('llama-3.3-70b-versatile');
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      // consecutive same-role turns merged
      { role: 'user', content: 'hi\n\nare you there?' },
    ]);
  });

  it('maps 401 to an invalid_key error naming the provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 }))
    );
    const err = (await generateOpenAiCompatible(args).catch((e) => e)) as AiError;
    expect(err).toBeInstanceOf(AiError);
    expect(err.code).toBe('invalid_key');
    expect(err.status).toBe(401);
    expect(err.message).toBe('Groq rejected the API key: Invalid API Key');
  });

  it('maps 429 (free-tier limits) to rate_limited', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    const err = (await generateOpenAiCompatible(args).catch((e) => e)) as AiError;
    expect(err.code).toBe('rate_limited');
  });

  it('rejects an empty completion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ choices: [{ message: { content: null } }] })));
    const err = (await generateOpenAiCompatible(args).catch((e) => e)) as AiError;
    expect(err.code).toBe('empty_response');
  });

  it('maps a network failure to network_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    const err = (await generateOpenAiCompatible(args).catch((e) => e)) as AiError;
    expect(err.code).toBe('network_error');
  });
});

describe('generateReply dispatch', () => {
  const config = (provider: string): AiConfig =>
    ({
      provider,
      model: 'm',
      apiKey: 'k',
      systemPrompt: null,
      isActive: true,
      autoReplyEnabled: true,
      autoReplyMaxPerConversation: 3,
      handoffAgentId: null,
      embeddingsApiKey: null,
    }) as AiConfig;

  it.each(AI_PROVIDERS.filter((p) => AI_PROVIDER_INFO[p].adapter === 'openai_compatible'))(
    'routes %s to its own endpoint',
    async (provider) => {
      const fetchMock = vi.fn(async () => ok({ choices: [{ message: { content: 'OK' } }] }));
      vi.stubGlobal('fetch', fetchMock);
      const res = await generateReply({
        config: config(provider),
        systemPrompt: 's',
        messages: [{ role: 'user', content: 'ping' }],
      });
      expect(res.text).toBe('OK');
      expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(`${AI_PROVIDER_INFO[provider].baseUrl}/chat/completions`);
    }
  );

  it('keeps OpenAI on its native endpoint', async () => {
    const fetchMock = vi.fn(async () => ok({ choices: [{ message: { content: 'OK' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await generateReply({ config: config('openai'), systemPrompt: 's', messages: [] });
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('rejects an unknown provider without calling out', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = (await generateReply({
      config: config('llama'),
      systemPrompt: 's',
      messages: [],
    }).catch((e) => e)) as AiError;
    expect(err.code).toBe('unsupported_provider');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('provider error shapes (seen live from each API)', () => {
  const cases: [string, number, unknown, string, string][] = [
    ['Gemini (400, array body)', 400, [{ error: { code: 400, message: 'Please pass a valid API key', status: 'INVALID_ARGUMENT' } }], 'invalid_key', 'Please pass a valid API key'],
    ['xAI (400, string error)', 400, { code: 'invalid-argument', error: 'Incorrect API key provided.' }, 'invalid_key', 'Incorrect API key provided.'],
    ['Mistral (401, detail)', 401, { detail: 'Invalid API Key' }, 'invalid_key', 'Invalid API Key'],
    ['Cerebras (401, message)', 401, { message: 'Wrong API Key' }, 'invalid_key', 'Wrong API Key'],
    ['bad model (400, not a key problem)', 400, { error: { message: 'The model `x` does not exist' } }, 'provider_error', 'does not exist'],
  ];

  it.each(cases)('%s', async (_name, status, body, code, detail) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
    const err = (await generateOpenAiCompatible(args).catch((e) => e)) as AiError;
    expect(err.code).toBe(code);
    expect(err.message).toContain(detail);
  });
});
