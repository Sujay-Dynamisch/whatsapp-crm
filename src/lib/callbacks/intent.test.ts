import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/features-server', () => ({ accountHasFeature: async () => true }));
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: async () => ({ apiKey: 'k', provider: 'openai', model: 'm' }) }));

import { decide, detectCallbackIntent, mightRequestCallback, parseIntent, validScheduledFor, worthClassifying } from './intent';

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
    const base = { language: 'en', requested_time: null, scheduled_for: null, reason: '' };
    expect(decide({ ...base, intent: 'callback_request', confidence: 0.9 }, 0.75)).toBe('definite');
    expect(decide({ ...base, intent: 'callback_request', confidence: 0.6 }, 0.75)).toBe('review');
    expect(decide({ ...base, intent: 'ambiguous', confidence: 0.5 }, 0.75)).toBe('review');
    expect(decide({ ...base, intent: 'ambiguous', confidence: 0.2 }, 0.75)).toBe('ignore');
    expect(decide({ ...base, intent: 'none', confidence: 0.99 }, 0.75)).toBe('ignore');
  });
});

describe('call time (102)', () => {
  it('an answer to “when shall we call?” is worth classifying, a plain “ok” is not', () => {
    const chat = [{ from: 'business' as const, text: 'Could you share a convenient date and time for the call?' }];
    expect(worthClassifying('12:30 tomorrow', chat)).toBe(true);
    expect(worthClassifying('12:30 tomorrow', [])).toBe(false);
    expect(worthClassifying('ok', [{ from: 'business', text: 'Here is the program info.' }])).toBe(false);
  });
  it('keeps only well-formed IST times in the next 30 days', () => {
    const now = Date.parse('2026-11-24T15:00:00+05:30');
    expect(validScheduledFor('2026-11-25T12:30:00+05:30', now)).toBe('2026-11-25T12:30:00+05:30');
    expect(validScheduledFor('2026-11-25T12:30:00Z', now)).toBeNull();
    expect(validScheduledFor('2026-10-01T12:30:00+05:30', now)).toBeNull();
    expect(validScheduledFor('tomorrow', now)).toBeNull();
  });
});

describe('detectCallbackIntent', () => {
  function db(rpcResult: string, lastBusiness = 'Could you share a convenient date and time for the call?') {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const b: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'ilike', 'limit']) b[k] = () => b;
    // Recent chat: the business just asked when to call.
    b.order = () => ({
      limit: async () => ({
        data: [
          { sender_type: 'customer', content_text: '12:30 tomorrow', message_id: 'wamid.1' },
          { sender_type: 'bot', content_text: lastBusiness, message_id: 'wamid.0' },
        ],
      }),
    });
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
    const out = await detectCallbackIntent(client, input, async () => ({ intent: 'callback_request', confidence: 0.95, language: 'en', requested_time: null, scheduled_for: null, reason: 'asks for a call' }));
    expect(out).toBe('created');
    expect(calls[0].fn).toBe('open_callback_from_intent');
    expect(calls[0].args).toMatchObject({ p_message_id: 'wamid.1', p_definite: true });
    expect((calls[0].args.p_meta as Record<string, unknown>).requested_time).toBe('ASAP / time not specified');
  });

  it('“12:30 tomorrow” after “when shall we call?” → priority callback with the time, chat given to the AI', async () => {
    const { client, calls } = db('created');
    const when = new Date(Date.now() + 864e5).toISOString().slice(0, 10) + 'T12:30:00+05:30';
    const classify = vi.fn(async (_config: unknown, _text: string, _chat?: unknown) => ({ intent: 'callback_request' as const, confidence: 0.9, language: 'en', requested_time: '12:30 tomorrow', scheduled_for: when, reason: 'answers the time' }));
    const out = await detectCallbackIntent(client, { ...input, text: '12:30 tomorrow' }, classify);
    expect(out).toBe('created');
    expect(classify.mock.calls[0][2]).toEqual([{ from: 'business', text: 'Could you share a convenient date and time for the call?' }]);
    expect(calls[0].args.p_meta).toMatchObject({ requested_time: '12:30 tomorrow', scheduled_for: when });
  });

  it('never calls the AI for messages without a call hint', async () => {
    const { client } = db('created', 'Here is the program information.');
    const classify = vi.fn();
    expect(await detectCallbackIntent(client, { ...input, text: 'ok thanks' }, classify)).toBe('no_hint');
    expect(classify).not.toHaveBeenCalled();
  });

  it('an ordinary mention is ignored', async () => {
    const { client, calls } = db('created');
    const out = await detectCallbackIntent(client, { ...input, text: 'the call yesterday was great' }, async () => ({ intent: 'none', confidence: 0.9, language: 'en', requested_time: null, scheduled_for: null, reason: '' }));
    expect(out).toBe('ignored');
    expect(calls).toHaveLength(0);
  });
});
