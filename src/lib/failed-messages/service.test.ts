import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { actOnFailed, listFailed, runScheduledResends, type SendDeps } from './service';
import { explainFailure } from '@/lib/whatsapp/error-hints';

// ------------------------------------------------------------------
// In-memory PostgREST stand-in (nested "a.b" filters for !inner joins)
// ------------------------------------------------------------------
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let seq = 0;
const get = (r: Row, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (Array.isArray(v) ? v[0] : v)[k as never] : undefined), r);

function fakeDb(): SupabaseClient {
  return {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const preds: ((r: Row) => boolean)[] = [];
      let op: 'select' | 'update' | 'insert' = 'select';
      let patch: Row | null = null;
      let inserted: Row[] = [];
      let single = false;
      let returning = false;
      let limitN = Infinity;
      const run = () => {
        if (op === 'insert') {
          const added = inserted.map((r) => ({ id: `id-${++seq}`, ...r }));
          rows.push(...added);
          return { data: single ? added[0] : returning ? added : null, error: null };
        }
        const hit = rows.filter((r) => preds.every((p) => p(r)));
        if (op === 'update') {
          for (const r of hit) Object.assign(r, patch);
          return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
        }
        const data = hit.slice(0, limitN).map((r) => structuredClone(r));
        return { data: single ? (data[0] ?? null) : data, error: null };
      };
      const b: Record<string, unknown> = {
        select: () => {
          if (op !== 'select') returning = true;
          return b;
        },
        insert: (r: Row | Row[]) => ((op = 'insert'), (inserted = Array.isArray(r) ? r : [r]), b),
        update: (p: Row) => ((op = 'update'), (patch = p), b),
        eq: (c: string, v: unknown) => (preds.push((r) => get(r, c) === v), b),
        in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(get(r, c))), b),
        gte: (c: string, v: string) => (preds.push((r) => r[c] != null && String(r[c]) >= v), b),
        lte: (c: string, v: string) => (preds.push((r) => r[c] != null && String(r[c]) <= v), b),
        lt: (c: string, v: string) => (preds.push((r) => r[c] != null && String(r[c]) < v), b),
        is: (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), b),
        order: () => b,
        limit: (n: number) => ((limitN = n), b),
        single: () => ((single = true), b),
        maybeSingle: () => ((single = true), b),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}
const db = () => fakeDb();

const NOW = new Date('2026-11-03T10:00:00Z');
const iso = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();
const ID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

let sent: string[];
let failNext: Error | null;
const deps: SendDeps = {
  now: () => NOW,
  sendTemplate: async (_c, cfg) => {
    if (failNext) {
      const e = failNext;
      failNext = null;
      throw e;
    }
    sent.push(`template:${cfg.template_name}:${(cfg.params ?? []).join('|')}`);
    return { whatsapp_message_id: `wamid-${sent.length}` };
  },
  sendText: async (_c, text) => {
    sent.push(`text:${text}`);
    return { whatsapp_message_id: `wamid-${sent.length}` };
  },
};

const conv = (id: string, contactId: string, lastCustomerHoursAgo: number | null) => ({
  id,
  account_id: 'acct',
  contact_id: contactId,
  last_customer_message_at: lastCustomerHoursAgo === null ? null : iso(-lastCustomerHoursAgo),
  user_id: 'owner',
});

beforeEach(() => {
  seq = 0;
  sent = [];
  failNext = null;
  tables = {
    contacts: [
      { id: 'c1', account_id: 'acct', name: 'Asha', phone: '+919800000001' },
      { id: 'c2', account_id: 'acct', name: 'Ravi', phone: '+919800000002' },
      { id: 'c3', account_id: 'acct', name: 'Stopped', phone: '+919800000003' },
    ],
    conversations: [conv('conv1', 'c1', 2), conv('conv2', 'c2', 30), conv('conv3', 'c3', 1)],
    contact_tags: [{ contact_id: 'c3', tags: { name: 'unsubscribe' } }],
    journeys: [{ id: 'j1', account_id: 'acct', name: 'Webinar Funnel', created_by: 'owner' }],
    journey_messages: [
      // 131049 on a nurture template, Asha's 24h window open.
      {
        id: ID(1), account_id: 'acct', journey_id: 'j1', enrollment_id: 'e1', contact_id: 'c1', node_id: 'b_send',
        kind: 'template', template_name: 'sg_nurture_postwebinar', language: 'en_US', params: ['Asha'],
        content_text: 'Hi Asha, still thinking?', wa_message_id: 'wamid-x', status: 'failed', error_code: 131049,
        error_title: 'healthy ecosystem', attempt: 1, retry_until: null, resolved: null, resolved_at: null, manual_retry_at: null,
        created_at: iso(-1),
      },
      // A retry step of an older chain — not shown on its own.
      {
        id: ID(2), account_id: 'acct', journey_id: 'j1', enrollment_id: 'e1', contact_id: 'c1', node_id: 'a_send',
        kind: 'template', template_name: 'sg_nurture_prewebinar', language: 'en_US', params: ['Asha'], content_text: null,
        wa_message_id: null, status: 'failed', error_code: 131049, error_title: null, attempt: 1, retry_until: null,
        resolved: 'retried', resolved_at: iso(-2), manual_retry_at: null, created_at: iso(-3),
      },
      // Opted-out contact.
      {
        id: ID(3), account_id: 'acct', journey_id: 'j1', enrollment_id: 'e3', contact_id: 'c3', node_id: 't1_confirm',
        kind: 'template', template_name: 'sg_webinar_confirmation', language: 'en_US', params: [], content_text: 'Hi',
        wa_message_id: null, status: 'failed', error_code: 131026, error_title: null, attempt: 1, retry_until: null,
        resolved: null, resolved_at: null, manual_retry_at: null, created_at: iso(-1),
      },
      // Another account — never visible.
      {
        id: ID(9), account_id: 'other', journey_id: 'jx', enrollment_id: 'ex', contact_id: 'cx', node_id: 'n',
        kind: 'template', template_name: 't', language: 'en_US', params: [], content_text: null, wa_message_id: null,
        status: 'failed', error_code: 1, error_title: null, attempt: 1, retry_until: null, resolved: null, resolved_at: null,
        manual_retry_at: null, created_at: iso(-1),
      },
    ],
    messages: [
      // Inbox text send to Ravi, window closed.
      {
        id: ID(4), conversation_id: 'conv2', sender_type: 'agent', content_type: 'text', content_text: 'Hello Ravi',
        template_name: null, message_id: null, status: 'failed', error_code: 131047, error_title: 'Re-engagement message',
        failure_resolved: null, failure_resolved_at: null, manual_retry_at: null, created_at: iso(-2),
        conversations: conv('conv2', 'c2', 30),
      },
      // Inbox template with variables we don't have.
      {
        id: ID(5), conversation_id: 'conv1', sender_type: 'bot', content_type: 'template', content_text: 'Hi Asha, your order',
        template_name: 'order_update', message_id: null, status: 'failed', error_code: 131000, error_title: null,
        failure_resolved: null, failure_resolved_at: null, manual_retry_at: null, created_at: iso(-0.5),
        conversations: conv('conv1', 'c1', 2),
      },
      // The journey send's inbox copy (same wamid) — shown once, as the journey one.
      {
        id: ID(6), conversation_id: 'conv1', sender_type: 'bot', content_type: 'template', content_text: 'Hi Asha, still thinking?',
        template_name: 'sg_nurture_postwebinar', message_id: 'wamid-x', status: 'failed', error_code: 131049, error_title: null,
        failure_resolved: null, failure_resolved_at: null, manual_retry_at: null, created_at: iso(-1),
        conversations: conv('conv1', 'c1', 2),
      },
    ],
    message_templates: [{ id: 't1', user_id: 'owner', account_id: 'acct', name: 'order_update', language: 'en_US', body_text: 'Hi {{1}}, your order {{2}}' }],
  };
});

const day = { from: iso(-12), to: iso(12), now: NOW };

describe('listFailed', () => {
  it('lists both sources for the account, once each, with reason, window and what can be done', async () => {
    const list = await listFailed(db(), 'acct', { ...day, status: 'open' });
    expect(list.items.map((i) => i.key).sort()).toEqual([`inbox:${ID(4)}`, `inbox:${ID(5)}`, `journey:${ID(1)}`, `journey:${ID(3)}`]);
    const byKey = Object.fromEntries(list.items.map((i) => [i.key, i]));
    expect(byKey[`journey:${ID(1)}`]).toMatchObject({
      contact_name: 'Asha',
      journey_name: 'Webinar Funnel',
      kind: 'template',
      window_open: true,
      fix: 'retry_later',
      resend_blocked: null,
    });
    expect(byKey[`journey:${ID(1)}`].reason).toContain('marketing');
    expect(byKey[`journey:${ID(3)}`]).toMatchObject({ opted_out: true, resend_blocked: 'opted_out' });
    expect(byKey[`inbox:${ID(4)}`]).toMatchObject({ kind: 'text', window_open: false, resend_blocked: 'window_closed', fix: 'fix_template' });
    expect(byKey[`inbox:${ID(5)}`]).toMatchObject({ kind: 'template', resend_blocked: 'needs_variables', window_open: true });
    expect(list.stats).toMatchObject({ failed: 4, open: 4, resolved: 0, window_open: 2 });
    expect(list.reasons[0]).toMatchObject({ count: expect.any(Number) });
  });

  it('respects the day range', async () => {
    const list = await listFailed(db(), 'acct', { from: iso(-0.75), to: iso(1), now: NOW, status: 'all' });
    expect(list.items.map((i) => i.key)).toEqual([`inbox:${ID(5)}`]);
  });
});

describe('actions', () => {
  const act = (keys: string[], action: Parameters<typeof actOnFailed>[1]['action'], extra: { at?: string; text?: string } = {}) =>
    actOnFailed(db(), { accountId: 'acct', userId: 'agent', keys, action, ...extra }, deps);

  it('resend: same template again; logged on the run and the failure marked handled', async () => {
    expect(await act([`journey:${ID(1)}`], 'resend')).toEqual([{ key: `journey:${ID(1)}`, ok: true }]);
    expect(sent).toEqual(['template:sg_nurture_postwebinar:Asha']);
    expect(tables.journey_messages[0]).toMatchObject({ resolved: 'resent', resolved_at: NOW.toISOString(), manual_retry_at: null });
    expect(tables.journey_messages.at(-1)).toMatchObject({ kind: 'retry', status: 'sent', attempt: 2, parent_id: ID(1), wa_message_id: 'wamid-1' });
    expect((await listFailed(db(), 'acct', { ...day, status: 'open' })).items.map((i) => i.key)).not.toContain(`journey:${ID(1)}`);
  });

  it('resend that Meta refuses again → reported, and the new failure is listed', async () => {
    failNext = new Error('(#131049) limited');
    const [r] = await act([`journey:${ID(1)}`], 'resend');
    expect(r).toMatchObject({ ok: false, error: 'send_failed', detail: '(#131049) limited' });
    const open = await listFailed(db(), 'acct', { ...day, status: 'open' });
    expect(open.items.find((i) => i.template_name === 'sg_nurture_postwebinar')).toMatchObject({ error_code: 131049 });
  });

  it('send_text: custom message while the 24h window is open', async () => {
    expect(await act([`journey:${ID(1)}`], 'send_text', { text: 'Hi Asha, still thinking? Reply here 🙂' })).toEqual([
      { key: `journey:${ID(1)}`, ok: true },
    ]);
    expect(sent).toEqual(['text:Hi Asha, still thinking? Reply here 🙂']);
    expect(tables.journey_messages[0].resolved).toBe('custom_text');
    expect(tables.journey_messages.at(-1)).toMatchObject({ kind: 'fallback', status: 'sent' });
  });

  it('send_text is refused when the window is closed; resend of a plain text too', async () => {
    expect((await act([`inbox:${ID(4)}`], 'send_text', { text: 'Hi' }))[0]).toMatchObject({ ok: false, error: 'window_closed' });
    expect((await act([`inbox:${ID(4)}`], 'resend'))[0]).toMatchObject({ ok: false, error: 'window_closed' });
    expect(sent).toEqual([]);
    expect(tables.messages[0].failure_resolved).toBeNull();
  });

  it('inbox template with unknown variables can’t be resent or scheduled, but can go as text', async () => {
    expect((await act([`inbox:${ID(5)}`], 'resend'))[0]).toMatchObject({ ok: false, error: 'needs_variables' });
    expect((await act([`inbox:${ID(5)}`], 'schedule', { at: iso(2) }))[0]).toMatchObject({ ok: false, error: 'needs_variables' });
    expect((await act([`inbox:${ID(5)}`], 'send_text', { text: 'Hi Asha, your order shipped' }))[0]).toMatchObject({ ok: true });
    expect(tables.messages[1]).toMatchObject({ failure_resolved: 'custom_text' });
  });

  it('never messages an opted-out contact', async () => {
    for (const action of ['resend', 'send_text', 'schedule'] as const) {
      const [r] = await act([`journey:${ID(3)}`], action, { text: 'x', at: iso(2) });
      expect(r, action).toMatchObject({ ok: false, error: 'opted_out' });
    }
    expect(sent).toEqual([]);
  });

  it('dismiss; already-handled and other accounts’ items are refused', async () => {
    expect(await act([`journey:${ID(1)}`], 'dismiss')).toEqual([{ key: `journey:${ID(1)}`, ok: true }]);
    expect(tables.journey_messages[0].resolved).toBe('dismissed');
    expect((await act([`journey:${ID(1)}`], 'resend'))[0]).toMatchObject({ ok: false, error: 'already_resolved' });
    expect((await act([`journey:${ID(9)}`], 'dismiss'))[0]).toMatchObject({ ok: false, error: 'not_found' });
    expect(tables.journey_messages[3].resolved).toBeNull();
  });

  it('schedule: only within the next 30 days; replaces the automatic retry; can be cancelled', async () => {
    expect((await act([`journey:${ID(1)}`], 'schedule', { at: iso(-1) }))[0]).toMatchObject({ ok: false, error: 'bad_time' });
    expect((await act([`journey:${ID(1)}`], 'schedule', { at: iso(24 * 31) }))[0]).toMatchObject({ ok: false, error: 'bad_time' });
    tables.journey_messages[0].next_retry_at = iso(4);
    expect((await act([`journey:${ID(1)}`], 'schedule', { at: iso(2) }))[0]).toMatchObject({ ok: true });
    expect(tables.journey_messages[0]).toMatchObject({ manual_retry_at: iso(2), next_retry_at: null });
    expect((await listFailed(db(), 'acct', { ...day, status: 'open' })).stats.scheduled).toBe(1);
    await act([`journey:${ID(1)}`], 'cancel_schedule');
    expect(tables.journey_messages[0].manual_retry_at).toBeNull();
  });
});

describe('runScheduledResends', () => {
  it('sends what is due once, skips what is not yet due or handled meanwhile', async () => {
    tables.journey_messages[0].manual_retry_at = iso(-0.1); // due
    tables.journey_messages[2].manual_retry_at = iso(1); // later
    tables.messages[0].manual_retry_at = iso(-0.1); // due, but window closed → skipped
    expect(await runScheduledResends(db(), deps)).toEqual({ sent: 1, failed: 0, skipped: 1 });
    expect(sent).toEqual(['template:sg_nurture_postwebinar:Asha']);
    expect(tables.journey_messages[0]).toMatchObject({ resolved: 'resent', manual_retry_at: null });
    expect(tables.journey_messages[2].manual_retry_at).toBe(iso(1));
    expect(await runScheduledResends(db(), deps)).toEqual({ sent: 0, failed: 0, skipped: 0 });
  });
});

describe('explainFailure', () => {
  it('known codes, title fallbacks, unknown', () => {
    expect(explainFailure(131049)).toMatchObject({ fix: 'retry_later', retryable: true });
    expect(explainFailure(132001)).toMatchObject({ fix: 'fix_template', retryable: false });
    expect(explainFailure(131026)).toMatchObject({ fix: 'check_number' });
    expect(explainFailure(190)).toMatchObject({ fix: 'reconnect' });
    expect(explainFailure(null, 'Message failed to send because more than 24 hours have passed')).toMatchObject({ fix: 'fix_template' });
    expect(explainFailure(null, 'Some new error')).toMatchObject({ reason: 'Some new error', fix: 'unknown', retryable: true });
    expect(explainFailure(null, null).reason).toBe('Sending failed for an unknown reason.');
  });
});
