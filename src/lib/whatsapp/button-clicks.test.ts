import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const feature = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/lib/features-server', () => ({
  accountHasFeature: vi.fn(async () => feature.enabled),
}));

import {
  cardIndexFromPayload,
  extractButtonTap,
  recordButtonClick,
  type InboundForClick,
} from './button-clicks';

// ------------------------------------------------------------------
// Fake service-role client: canned lookups + recorded upserts.
// ------------------------------------------------------------------
interface Fake {
  recipient?: Record<string, unknown> | null;
  message?: Record<string, unknown> | null;
  upsertError?: string;
}
let fake: Fake;
let upserts: { row: Record<string, unknown>; opts: unknown }[];
let filters: Record<string, Record<string, unknown>>;

function db(): SupabaseClient {
  return {
    from(table: string) {
      filters[table] = {};
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => ((filters[table][c] = v), b),
        maybeSingle: async () => ({
          data: table === 'broadcast_recipients' ? fake.recipient ?? null : fake.message ?? null,
          error: null,
        }),
        upsert: async (row: Record<string, unknown>, opts: unknown) => {
          upserts.push({ row, opts });
          return { error: fake.upsertError ? { message: fake.upsertError } : null };
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const base = {
  accountId: 'acct-1',
  contactId: 'contact-1',
  conversationId: 'conv-1',
  messageRowId: 'msg-row-1',
  waMessageId: 'wamid.IN',
  clickedAt: new Date('2026-10-07T10:00:00Z'),
};

const templateTap = (payload = 'Buy now'): InboundForClick => ({
  type: 'button',
  button: { text: 'Buy now', payload },
  context: { id: 'wamid.OUT' },
});

beforeEach(() => {
  feature.enabled = true;
  fake = {};
  upserts = [];
  filters = {};
});

describe('extractButtonTap', () => {
  it('reads a template quick-reply tap (standard or carousel)', () => {
    expect(extractButtonTap(templateTap('BUY_1'))).toEqual({
      kind: 'template_quick_reply',
      text: 'Buy now',
      payload: 'BUY_1',
      contextId: 'wamid.OUT',
    });
  });

  it('reads interactive reply buttons and list rows', () => {
    expect(
      extractButtonTap({
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Yes' } },
        context: { id: 'wamid.X' },
      })
    ).toEqual({ kind: 'interactive_button', text: 'Yes', payload: 'yes', contextId: 'wamid.X' });
    expect(
      extractButtonTap({
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'row2', title: 'Plan B' } },
      })
    ).toEqual({ kind: 'interactive_list', text: 'Plan B', payload: 'row2', contextId: null });
  });

  it('ignores anything that is not a tap', () => {
    expect(extractButtonTap({ type: 'text' })).toBeNull();
    expect(extractButtonTap({ type: 'interactive', interactive: {} })).toBeNull();
    expect(extractButtonTap({ type: 'button' })).toBeNull();
  });
});

describe('cardIndexFromPayload', () => {
  it('reads the carousel card from the default payload only', () => {
    expect(cardIndexFromPayload('card_2_btn_0')).toBe(2);
    expect(cardIndexFromPayload('Buy now')).toBeNull();
    expect(cardIndexFromPayload(null)).toBeNull();
  });
});

describe('recordButtonClick', () => {
  it('credits a broadcast tap to the broadcast, recipient and template', async () => {
    fake.recipient = {
      id: 'recip-1',
      broadcast_id: 'bc-1',
      broadcasts: { account_id: 'acct-1', template_name: 'summer_sale' },
    };
    const out = await recordButtonClick(db(), { ...base, message: templateTap('card_1_btn_0') });

    expect(out).toBe('recorded');
    // Account-scoped lookup so a forged context id can't hit another tenant.
    expect(filters.broadcast_recipients).toEqual({
      whatsapp_message_id: 'wamid.OUT',
      'broadcasts.account_id': 'acct-1',
    });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].row).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contact-1',
      conversation_id: 'conv-1',
      message_id: 'msg-row-1',
      context_wa_message_id: 'wamid.OUT',
      button_kind: 'template_quick_reply',
      button_text: 'Buy now',
      button_payload: 'card_1_btn_0',
      card_index: 1,
      source: 'broadcast',
      broadcast_id: 'bc-1',
      broadcast_recipient_id: 'recip-1',
      template_name: 'summer_sale',
      clicked_at: '2026-10-07T10:00:00.000Z',
    });
    // Replayed webhook deliveries can't double count.
    expect(upserts[0].opts).toEqual({ onConflict: 'message_id', ignoreDuplicates: true });
  });

  it('credits an inbox template sent by an agent', async () => {
    fake.message = { sender_type: 'agent', template_name: 'order_update' };
    await recordButtonClick(db(), { ...base, message: templateTap() });
    expect(filters.messages).toEqual({ conversation_id: 'conv-1', message_id: 'wamid.OUT' });
    expect(upserts[0].row).toMatchObject({
      source: 'inbox',
      template_name: 'order_update',
      broadcast_id: null,
    });
  });

  it('credits a flow / automation / AI message as bot', async () => {
    fake.message = { sender_type: 'bot', template_name: null };
    await recordButtonClick(db(), {
      ...base,
      message: {
        type: 'interactive',
        interactive: { button_reply: { id: 'menu_pricing', title: 'Pricing' } },
        context: { id: 'wamid.BOT' },
      },
    });
    expect(upserts[0].row).toMatchObject({ source: 'bot', button_kind: 'interactive_button' });
  });

  it('records with source unknown when the tapped message is not found', async () => {
    await recordButtonClick(db(), { ...base, message: { ...templateTap(), context: undefined } });
    expect(upserts[0].row).toMatchObject({ source: 'unknown', context_wa_message_id: null });
  });

  it('records nothing when the account has button analytics switched off', async () => {
    feature.enabled = false;
    expect(await recordButtonClick(db(), { ...base, message: templateTap() })).toBe('feature_off');
    expect(upserts).toHaveLength(0);
    expect(filters).toEqual({});
  });

  it('skips non-click messages without any lookup', async () => {
    expect(await recordButtonClick(db(), { ...base, message: { type: 'text' } })).toBe('not_a_click');
    expect(filters).toEqual({});
  });

  it('never throws — a database error is logged and reported', async () => {
    fake.upsertError = 'permission denied';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await recordButtonClick(db(), { ...base, message: templateTap() })).toBe('failed');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
