import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendText = vi.fn();
const sendTemplate = vi.fn();
const addTag = vi.fn(async (_a: unknown) => true);
const claim = vi.fn(async (_a: unknown) => null);
vi.mock('@/lib/automations/meta-send', () => ({
  engineSendText: (a: unknown) => sendText(a),
  engineSendTemplate: (a: unknown) => sendTemplate(a),
}));
vi.mock('@/lib/contacts/tag-write', () => ({ addContactTagIfAbsent: (_db: unknown, a: unknown) => addTag(a) }));
vi.mock('@/lib/journeys/engine', () => ({ ensureConversation: async () => 'conv-new' }));
vi.mock('@/lib/payments/link-once', () => ({ claimPaymentLink: (_db: unknown, a: unknown) => claim(a) }));

import { PaymentLinkError, sendCallbackPaymentLink } from './timeline';

type Rows = Record<string, unknown[]>;
let tables: Rows;
const inserted: Record<string, unknown[]> = {};

/** Minimal chainable fake: filters are ignored except eq on `name` (templates/tags). */
function db() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => ((filters[k] = v), q),
        ilike: (k: string, v: unknown) => ((filters[k] = v), q),
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: rows()[0] ?? null }),
        then: (r: (v: { data: unknown[] }) => unknown) => Promise.resolve({ data: rows() }).then(r),
        insert: async (row: unknown) => {
          (inserted[table] ??= []).push(row);
          return { error: null };
        },
      };
      const rows = () =>
        (tables[table] ?? []).filter((r) => {
          const row = r as Record<string, unknown>;
          return Object.entries(filters).every(([k, v]) => !(k in row) || String(row[k]).toLowerCase() === String(v).toLowerCase());
        });
      return q;
    },
  } as never;
}

const graph = (link: string) => ({
  nodes: [{ id: 'settings', type: 'set_variable', config: { assignments: [{ key: 'payment_link', value: link }] } }],
});

beforeEach(() => {
  vi.clearAllMocks();
  sendText.mockResolvedValue({ whatsapp_message_id: 'wamid.t', content_text: null });
  sendTemplate.mockResolvedValue({ whatsapp_message_id: 'wamid.p', content_text: null });
  for (const k of Object.keys(inserted)) delete inserted[k];
  tables = {
    callback_requests: [{ id: 'cb1', account_id: 'acct', contact_id: 'c1', conversation_id: 'conv1', contacts: { name: 'Priya' } }],
    journeys: [{ account_id: 'acct', status: 'active', graph: graph('razorpay.me/@revibe') }],
    conversations: [{ id: 'conv1', last_customer_message_at: new Date(Date.now() - 3600_000).toISOString() }],
    message_templates: [{ account_id: 'acct', name: 'sg_general_update', status: 'APPROVED' }],
    tags: [{ id: 'tag-pl', account_id: 'acct', name: 'payment_link_sent' }],
  };
});

const args = { accountId: 'acct', userId: 'u1', callbackId: 'cb1' };

describe('Send payment link from a callback card', () => {
  it('inside the 24h window: sends the journey text with the link, tags and logs it', async () => {
    const r = await sendCallbackPaymentLink(db(), args);
    expect(r.via).toBe('text');
    expect(sendText).toHaveBeenCalledTimes(1);
    const sent = sendText.mock.calls[0][0] as { text: string; conversationId: string; contactId: string };
    expect(sent.conversationId).toBe('conv1');
    expect(sent.contactId).toBe('c1');
    expect(sent.text).toContain('Great decision, Priya!');
    expect(sent.text).toContain('razorpay.me/@revibe');
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(addTag).toHaveBeenCalledWith({ accountId: 'acct', contactId: 'c1', tagId: 'tag-pl' });
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c1', config: expect.objectContaining({ on_request: true }) }));
    expect(inserted.callback_events?.[0]).toMatchObject({ kind: 'payment_link', value: 'text', detail: 'razorpay.me/@revibe', actor_id: 'u1' });
  });

  it('window closed: sends the approved sg_general_update template with name + link', async () => {
    tables.conversations = [{ id: 'conv1', last_customer_message_at: new Date(Date.now() - 3 * 864e5).toISOString() }];
    const r = await sendCallbackPaymentLink(db(), args);
    expect(r.via).toBe('template');
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'sg_general_update', params: ['Priya', 'Here is your payment link to join Revibe: razorpay.me/@revibe'] })
    );
    expect(inserted.callback_events?.[0]).toMatchObject({ value: 'template' });
  });

  it('window closed and template not approved: clear error, nothing sent', async () => {
    tables.conversations = [{ id: 'conv1', last_customer_message_at: null }];
    tables.message_templates = [];
    await expect(sendCallbackPaymentLink(db(), args)).rejects.toBeInstanceOf(PaymentLinkError);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(addTag).not.toHaveBeenCalled();
  });

  it('no payment link set up (placeholder): clear error, nothing sent', async () => {
    tables.journeys = [{ account_id: 'acct', status: 'active', graph: graph('https://PASTE-PAYMENT-LINK') }];
    await expect(sendCallbackPaymentLink(db(), args)).rejects.toThrow(/No payment link/);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('a failed WhatsApp send is not tagged or logged', async () => {
    sendText.mockRejectedValueOnce(new Error('Meta down'));
    await expect(sendCallbackPaymentLink(db(), args)).rejects.toThrow('Meta down');
    expect(addTag).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(inserted.callback_events).toBeUndefined();
  });
});
