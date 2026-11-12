import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/features-server', () => ({ accountHasFeature: async () => true }));
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: async () => ({ apiKey: 'k', provider: 'openai', model: 'm' }) }));

import { decide, detectCallbackIntent, mightRequestCallback, parseIntent } from './intent';

describe('mightRequestCallback', () => {
  it.each([
    'Please call me, typing is difficult',
    'mujhe call karo',
    'मला फोन करा',
    'can we talk on phone?',
    'मुझसे बात कीजिए',
  ])('flags %s', (t) => expect(mightRequestCallback(t)).toBe(true));
  it.each(['ok thanks', 'what is the fee?', '1'])('skips %s', (t) => expect(mightRequestCallback(t)).toBe(false));
});

describe('parseIntent / decide', () => {
  it('parses fenced JSON and clamps confidence', () => {
    const r = parseIntent('```json\n{"intent":"callback_request","confidence":1.4,"language":"hi","requested_time":"after 6 pm","reason":"asks to call"}\n```');
    expect(r).toMatchObject({ intent: 'callback_request', confidence: 1, language: 'hi', requested_time: 'after 6 pm' });
  });
  it('rejects junk', () => {
    expect(parseIntent('sure!')).toBeNull();
    expect(parseIntent('{"intent":"maybe"}')).toBeNull();
  });
  it('definite only at/above the threshold; low or ambiguous → review; none → ignore', () => {
    const base = { language: 'en', requested_time: null, reason: '' };
    expect(decide({ ...base, intent: 'callback_request', confidence: 0.9 }, 0.75)).toBe('definite');
    expect(decide({ ...base, intent: 'callback_request', confidence: 0.6 }, 0.75)).toBe('review');
    expect(decide({ ...base, intent: 'ambiguous', confidence: 0.5 }, 0.75)).toBe('review');
    expect(decide({ ...base, intent: 'ambiguous', confidence: 0.2 }, 0.75)).toBe('ignore');
    expect(decide({ ...base, intent: 'none', confidence: 0.99 }, 0.75)).toBe('ignore');
  });
});

describe('detectCallbackIntent', () => {
  function db(rpcResult: string) {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const b: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'ilike', 'limit']) b[k] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null });
    return {
      calls,
      client: {
        from: () => b,
        rpc: async (fn: string, args: Record<string, unknown>) => (calls.push({ fn, args }), { data: rpcResult, error: null }),
      } as unknown as SupabaseClient,
    };
  }
  const input = { accountId: 'a', contactId: 'c', conversationId: 'v', waMessageId: 'wamid.1', text: 'Please call me, typing is difficult' };

  it('a clear request opens a priority callback keyed by the message id', async () => {
    const { client, calls } = db('created');
    const out = await detectCallbackIntent(client, input, async () => ({ intent: 'callback_request', confidence: 0.95, language: 'en', requested_time: null, reason: 'asks for a call' }));
    expect(out).toBe('created');
    expect(calls[0].fn).toBe('open_callback_from_intent');
    expect(calls[0].args).toMatchObject({ p_message_id: 'wamid.1', p_definite: true });
    expect((calls[0].args.p_meta as Record<string, unknown>).requested_time).toBe('ASAP / time not specified');
  });

  it('never calls the AI for messages without a call hint', async () => {
    const { client } = db('created');
    const classify = vi.fn();
    expect(await detectCallbackIntent(client, { ...input, text: 'ok thanks' }, classify)).toBe('no_hint');
    expect(classify).not.toHaveBeenCalled();
  });

  it('an ordinary mention is ignored', async () => {
    const { client, calls } = db('created');
    const out = await detectCallbackIntent(client, { ...input, text: 'the call yesterday was great' }, async () => ({ intent: 'none', confidence: 0.9, language: 'en', requested_time: null, reason: '' }));
    expect(out).toBe('ignored');
    expect(calls).toHaveLength(0);
  });
});
