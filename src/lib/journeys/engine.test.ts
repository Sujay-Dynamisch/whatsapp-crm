import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { newNode, type JourneyGraph, type JourneyNode } from './graph';
import {
  enrollContact,
  interpolate,
  resumeOnReply,
  runJourneyTick,
  stopEnrollment,
  type JourneyDeps,
  type JourneyRow,
} from './engine';
import { triggerMatches } from './dispatch';
import { applyJourneyMessageStatus, metaErrorCode, planRetry, sendJourneyFallbacks } from './messages';

// ============================================================
// In-memory PostgREST stand-in: enough of the query surface for the
// engine, including the live-enrollment unique index (23505) and the
// tick's claim function.
// ============================================================
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let seq = 0;

function fakeDb(): SupabaseClient {
  return {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const preds: ((r: Row) => boolean)[] = [];
      let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
      let patch: Row | null = null;
      let inserted: Row[] = [];
      let head = false;
      let single: 'one' | 'maybe' | null = null;
      let returning = false;
      let limitN = Infinity;

      const run = () => {
        if (op === 'insert') {
          for (const r of inserted) {
            if (
              table === 'journey_enrollments' &&
              rows.some(
                (x) =>
                  x.journey_id === r.journey_id &&
                  x.contact_id === r.contact_id &&
                  (x.status === 'active' || x.status === 'waiting')
              )
            ) {
              return { data: null, error: { code: '23505', message: 'duplicate key' } };
            }
          }
          const added = inserted.map((r) => ({ id: `id-${++seq}`, context: {}, steps_taken: 0, ...r }));
          rows.push(...added);
          const data = returning ? added.map((r) => ({ ...r })) : null;
          return { data: single ? data?.[0] ?? null : data, error: null };
        }
        const hit = rows.filter((r) => preds.every((p) => p(r)));
        if (op === 'update') {
          for (const r of hit) Object.assign(r, patch);
          return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
        }
        if (op === 'delete') {
          tables[table] = rows.filter((r) => !hit.includes(r));
          return { data: null, error: null };
        }
        if (head) return { data: null, count: hit.length, error: null };
        const data = hit.slice(0, limitN).map((r) => ({ ...r }));
        if (single) return { data: data[0] ?? null, error: null };
        return { data, error: null };
      };

      const b: Record<string, unknown> = {
        select: (_c?: string, o?: { head?: boolean }) => {
          if (op !== 'select') returning = true;
          if (o?.head) head = true;
          return b;
        },
        insert: (r: Row | Row[]) => ((op = 'insert'), (inserted = Array.isArray(r) ? r : [r]), b),
        update: (p: Row) => ((op = 'update'), (patch = p), b),
        delete: () => ((op = 'delete'), b),
        eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), b),
        in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), b),
        gte: (c: string, v: string) => (preds.push((r) => r[c] != null && String(r[c]) >= v), b),
        lte: (c: string, v: string) => (preds.push((r) => r[c] != null && String(r[c]) <= v), b),
        gt: (c: string, v: string) => (preds.push((r) => r[c] != null && String(r[c]) > v), b),
        is: (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), b),
        limit: (n: number) => ((limitN = n), b),
        order: () => b,
        single: () => ((single = 'one'), b),
        maybeSingle: () => ((single = 'maybe'), b),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(res, rej),
      };
      return b;
    },
    rpc: async (fn: string) => {
      if (fn !== 'claim_journey_enrollments') throw new Error(fn);
      const nowIso = clock.toISOString();
      const due = (tables.journey_enrollments ?? []).filter(
        (e) => e.status === 'waiting' && String(e.next_run_at) <= nowIso
      );
      for (const e of due) Object.assign(e, { status: 'active', locked_at: nowIso });
      return { data: due.map((e) => ({ ...e })), error: null };
    },
  } as unknown as SupabaseClient;
}

// ============================================================
// Recorded side effects + controllable clock
// ============================================================
let clock: Date;
let sent: string[];
let failSendWith: Error | null;
const deps: JourneyDeps = {
  now: () => clock,
  sendTemplate: async (_ctx, cfg) => {
    if (failSendWith) throw failSendWith;
    sent.push(`template:${cfg.template_name}:${(cfg.params ?? []).join('|')}`);
    return { whatsapp_message_id: `wamid-${sent.length}`, content_text: `${cfg.template_name} body` };
  },
  sendText: async (_ctx, text) => {
    sent.push(`text:${text}`);
    return { whatsapp_message_id: `wamid-${sent.length}` };
  },
  addTag: async (ctx, tagId) => {
    tables.contact_tags.push({ id: `ct-${++seq}`, contact_id: ctx.contactId, tag_id: tagId });
  },
};

const T0 = new Date('2026-10-12T09:00:00Z');
const minutes = (m: number) => new Date(T0.getTime() + m * 60_000);
const db = () => fakeDb();

function journeyWith(graph: JourneyGraph, extra: Partial<JourneyRow> = {}): JourneyRow {
  const row: JourneyRow = {
    id: 'j1',
    account_id: 'acct',
    status: 'active',
    trigger_type: 'manual',
    trigger_config: {},
    graph,
    allow_reentry: false,
    created_by: 'user-1',
    ...extra,
  };
  tables.journeys = [row as unknown as Row];
  return row;
}

/**
 * trigger → send welcome → wait for reply (1h)
 *   replied → add tag "hot" → end
 *   timeout → wait 1 day → send reminder → end
 */
function nurtureGraph(): JourneyGraph {
  const n = <T extends Parameters<typeof newNode>[0]>(t: T, id: string) => newNode(t, undefined, id) as JourneyNode;
  const t = n('trigger', 't');
  const welcome = n('send_template', 'welcome');
  welcome.config = { template_name: 'welcome', params: ['{{name}}'] };
  const w = n('wait_for_reply', 'wfr');
  w.config = { amount: 1, unit: 'hours' };
  const tag = n('add_tag', 'tag');
  tag.config = { tag_id: 'hot' };
  const end1 = n('end', 'end1');
  const wait = n('wait', 'wait');
  wait.config = { amount: 1, unit: 'days' };
  const remind = n('send_template', 'remind');
  remind.config = { template_name: 'reminder' };
  const end2 = n('end', 'end2');
  t.next.next = 'welcome';
  welcome.next.next = 'wfr';
  w.next.replied = 'tag';
  w.next.timeout = 'wait';
  tag.next.next = 'end1';
  wait.next.next = 'remind';
  remind.next.next = 'end2';
  return { nodes: [t, welcome, w, tag, end1, wait, remind, end2] };
}

const enrollment = () => tables.journey_enrollments[0];
const events = () => tables.journey_events.map((e) => `${e.node_id}:${e.event}`);

beforeEach(() => {
  seq = 0;
  clock = T0;
  sent = [];
  failSendWith = null;
  tables = {
    contacts: [{ id: 'c1', account_id: 'acct', name: 'Asha', phone: '+919800000001' }],
    conversations: [{ id: 'conv1', account_id: 'acct', contact_id: 'c1', last_customer_message_at: null }],
    messages: [],
    contact_tags: [],
    button_clicks: [],
    journey_enrollments: [],
    journey_events: [],
    accounts: [{ id: 'acct', default_currency: 'INR' }],
    deals: [],
  };
});

describe('enroll → wait for reply → replied branch', () => {
  it('sends, parks on the reply wait, then resumes via "replied" when the customer answers', async () => {
    const j = journeyWith(nurtureGraph());
    const r = await enrollContact(db(), j, 'c1', deps);
    expect(r).toEqual({ enrolled: true, outcome: 'waiting' });
    expect(sent).toEqual(['template:welcome:Asha']);
    expect(enrollment()).toMatchObject({
      status: 'waiting',
      wait_kind: 'reply',
      current_node_id: 'wfr',
      next_run_at: minutes(60).toISOString(),
    });

    clock = minutes(10);
    expect(await resumeOnReply(db(), 'acct', 'c1', deps)).toBe(1);
    expect(enrollment()).toMatchObject({ status: 'completed', current_node_id: 'end1' });
    expect(tables.contact_tags).toEqual([expect.objectContaining({ contact_id: 'c1', tag_id: 'hot' })]);
    expect(events()).toEqual([
      't:entered', 't:exit:next',
      'welcome:entered', 'welcome:exit:next',
      'wfr:entered', 'wfr:exit:replied',
      'tag:entered', 'tag:exit:next',
      'end1:entered',
    ]);
  });
});

describe('timeout branch via the tick', () => {
  it('times out, waits a day, sends the reminder and completes', async () => {
    const j = journeyWith(nurtureGraph());
    await enrollContact(db(), j, 'c1', deps);

    clock = minutes(30); // not due yet
    expect((await runJourneyTick(db(), deps)).claimed).toBe(0);

    clock = minutes(61); // reply timeout
    const r1 = await runJourneyTick(db(), deps);
    expect(r1).toMatchObject({ claimed: 1, outcomes: { waiting: 1 } });
    expect(enrollment()).toMatchObject({ current_node_id: 'wait', wait_kind: 'timer' });

    clock = minutes(61 + 24 * 60 + 1); // the day has passed
    const r2 = await runJourneyTick(db(), deps);
    expect(r2.outcomes.completed).toBe(1);
    expect(sent).toEqual(['template:welcome:Asha', 'template:reminder:']);
    expect(events()).toContain('wfr:exit:timeout');
    expect(events()).toContain('wait:exit:next');
  });

  it('a reply after the timeout has fired no longer resumes anything', async () => {
    const j = journeyWith(nurtureGraph());
    await enrollContact(db(), j, 'c1', deps);
    clock = minutes(61);
    await runJourneyTick(db(), deps);
    expect(await resumeOnReply(db(), 'acct', 'c1', deps)).toBe(0);
  });
});

describe('enrollment rules', () => {
  it('never enrolls the same contact twice (no re-entry)', async () => {
    const j = journeyWith(nurtureGraph());
    await enrollContact(db(), j, 'c1', deps);
    expect(await enrollContact(db(), j, 'c1', deps)).toEqual({ enrolled: false, reason: 'already_enrolled' });
    expect(tables.journey_enrollments).toHaveLength(1);
  });

  it('with re-entry, still only one live enrollment at a time', async () => {
    const j = journeyWith(nurtureGraph(), { allow_reentry: true });
    await enrollContact(db(), j, 'c1', deps);
    expect(await enrollContact(db(), j, 'c1', deps)).toEqual({ enrolled: false, reason: 'already_live' });
  });

  it('does not enroll into inactive journeys', async () => {
    const j = journeyWith(nurtureGraph(), { status: 'paused' });
    expect(await enrollContact(db(), j, 'c1', deps)).toEqual({ enrolled: false, reason: 'journey_not_active' });
  });

  it('contacts waiting in a journey that gets paused exit when next woken', async () => {
    const j = journeyWith(nurtureGraph());
    await enrollContact(db(), j, 'c1', deps);
    (tables.journeys[0] as Row).status = 'paused';
    clock = minutes(61);
    const r = await runJourneyTick(db(), deps);
    expect(r.outcomes.exited).toBe(1);
    expect(enrollment().status).toBe('exited');
    expect(sent).toEqual(['template:welcome:Asha']);
  });
});

describe('conditions', () => {
  function conditionGraph(cfg: Row): JourneyGraph {
    const t = newNode('trigger', undefined, 't') as JourneyNode;
    const c = newNode('condition', undefined, 'c') as JourneyNode;
    c.config = cfg as never;
    const yes = newNode('send_text', undefined, 'yes') as JourneyNode;
    yes.config = { text: 'Thanks {{name}}!' };
    const no = newNode('end', undefined, 'no') as JourneyNode;
    const end = newNode('end', undefined, 'end') as JourneyNode;
    t.next.next = 'c';
    c.next = { yes: 'yes', no: 'no' };
    yes.next.next = 'end';
    return { nodes: [t, c, yes, no, end] };
  }

  it('clicked_button matches a tap since enrollment (label or payload, any case)', async () => {
    tables.conversations[0].last_customer_message_at = T0.toISOString();
    tables.button_clicks.push({
      id: 'b1', account_id: 'acct', contact_id: 'c1', button_text: 'Buy Now', button_payload: 'BUY',
      clicked_at: T0.toISOString(),
    });
    const j = journeyWith(conditionGraph({ kind: 'clicked_button', button_text: 'buy now' }));
    await enrollContact(db(), j, 'c1', deps);
    expect(events()).toContain('c:exit:yes');
    expect(sent).toEqual(['text:Thanks Asha!']);
  });

  it('a tap from before the enrollment does not count', async () => {
    tables.button_clicks.push({
      id: 'b1', account_id: 'acct', contact_id: 'c1', button_text: 'Buy Now',
      clicked_at: minutes(-60).toISOString(),
    });
    const j = journeyWith(conditionGraph({ kind: 'clicked_button', button_text: 'Buy Now' }));
    await enrollContact(db(), j, 'c1', deps);
    expect(events()).toContain('c:exit:no');
  });

  it('has_tag', async () => {
    tables.contact_tags.push({ id: 'x', contact_id: 'c1', tag_id: 'vip' });
    tables.conversations[0].last_customer_message_at = T0.toISOString();
    const j = journeyWith(conditionGraph({ kind: 'has_tag', tag_id: 'vip' }));
    await enrollContact(db(), j, 'c1', deps);
    expect(events()).toContain('c:exit:yes');
  });
});

describe('failures and safety', () => {
  it('a text step outside the 24h window fails the enrollment with a clear reason', async () => {
    const t = newNode('trigger', undefined, 't') as JourneyNode;
    const s = newNode('send_text', undefined, 's') as JourneyNode;
    s.config = { text: 'hello' };
    const e = newNode('end', undefined, 'e') as JourneyNode;
    t.next.next = 's';
    s.next.next = 'e';
    const j = journeyWith({ nodes: [t, s, e] });
    expect(await enrollContact(db(), j, 'c1', deps)).toEqual({ enrolled: true, outcome: 'failed' });
    expect(enrollment().last_error).toMatch(/24 hours/);
    expect(events()).toContain('s:failed');
    expect(sent).toEqual([]);
  });

  it('a failed template send is logged and the run carries on', async () => {
    failSendWith = new Error('(#132001) Template name does not exist in the translation');
    const j = journeyWith(nurtureGraph());
    expect((await enrollContact(db(), j, 'c1', deps)).outcome).toBe('waiting');
    expect(enrollment()).toMatchObject({ status: 'waiting', current_node_id: 'wfr' });
    expect(events()).toContain('welcome:send_failed');
    expect(tables.journey_messages).toEqual([
      expect.objectContaining({ node_id: 'welcome', kind: 'template', status: 'failed', error_code: 132001, next_retry_at: null }),
    ]);
  });

  it('stops a runaway graph instead of spinning forever', async () => {
    const t = newNode('trigger', undefined, 't') as JourneyNode;
    const a = newNode('remove_tag', undefined, 'a') as JourneyNode;
    a.config = { tag_id: 'x' };
    const b = newNode('remove_tag', undefined, 'b') as JourneyNode;
    b.config = { tag_id: 'y' };
    t.next.next = 'a';
    a.next.next = 'b';
    b.next.next = 'a';
    const j = journeyWith({ nodes: [t, a, b] });
    expect((await enrollContact(db(), j, 'c1', deps)).outcome).toBe('failed');
    expect(enrollment().last_error).toMatch(/without a wait/);
  });

  it('creates a deal with the account currency and the contact name', async () => {
    const t = newNode('trigger', undefined, 't') as JourneyNode;
    const d = newNode('create_deal', undefined, 'd') as JourneyNode;
    d.config = { pipeline_id: 'p', stage_id: 's', title: 'Lead: {{name}}', value: 2500 };
    const e = newNode('end', undefined, 'e') as JourneyNode;
    t.next.next = 'd';
    d.next.next = 'e';
    const j = journeyWith({ nodes: [t, d, e] });
    expect((await enrollContact(db(), j, 'c1', deps)).outcome).toBe('completed');
    expect(tables.deals[0]).toMatchObject({
      account_id: 'acct', contact_id: 'c1', title: 'Lead: Asha', value: 2500, currency: 'INR', status: 'open',
    });
  });

  it('creates the conversation for a contact who has none before sending', async () => {
    tables.conversations = [];
    tables.whatsapp_config = [{ account_id: 'acct', user_id: 'owner' }];
    const j = journeyWith(nurtureGraph());
    await enrollContact(db(), j, 'c1', deps);
    expect(tables.conversations).toEqual([
      expect.objectContaining({ account_id: 'acct', contact_id: 'c1', status: 'open' }),
    ]);
    expect(sent).toEqual(['template:welcome:Asha']);
  });
});

describe('helpers', () => {
  it('interpolate', () => {
    expect(interpolate('Hi {{ name }}, we will call {{phone}}', { name: 'Ravi', phone: '+91 98' })).toBe(
      'Hi Ravi, we will call +91 98'
    );
    expect(interpolate('Hi {{name}}', {})).toBe('Hi ');
  });

  it('triggerMatches', () => {
    const tag = { trigger_config: { tag_id: 'vip' } };
    expect(triggerMatches(tag, { accountId: 'a', contactId: 'c', trigger: 'tag_added', tagId: 'vip' })).toBe(true);
    expect(triggerMatches(tag, { accountId: 'a', contactId: 'c', trigger: 'tag_added', tagId: 'x' })).toBe(false);
    const btn = { trigger_config: { button_text: 'Buy now' } };
    expect(triggerMatches(btn, { accountId: 'a', contactId: 'c', trigger: 'button_clicked', buttonText: 'BUY NOW' })).toBe(true);
    expect(triggerMatches({ trigger_config: {} }, { accountId: 'a', contactId: 'c', trigger: 'button_clicked', buttonText: 'x' })).toBe(true);
  });
});

// ============================================================
// Workflow steps (migration 054)
// ============================================================
describe('workflow steps (054)', () => {
  const node = <T extends Parameters<typeof newNode>[0]>(t: T, id: string, config?: unknown) => {
    const n = newNode(t, undefined, id) as JourneyNode;
    if (config) n.config = config as never;
    return n;
  };
  const openWindow = () => {
    tables.conversations[0].last_customer_message_at = T0.toISOString();
  };
  const httpDeps = (respond: (url: string, init: RequestInit) => Response): JourneyDeps => ({
    ...deps,
    checkUrl: async () => true,
    http: async (url, init) => respond(url, init),
  });
  const noBody = { headers: [], query: [], body_type: 'none', body: '', form: [] };

  it('passes an HTTP response into a later message', async () => {
    openWindow();
    const t = node('trigger', 't');
    const h = node('http_request', 'h', {
      method: 'POST',
      url: 'https://api.example.com/orders/{{ trigger.order_id }}',
      headers: [{ key: 'Authorization', value: 'Bearer k' }],
      query: [],
      body_type: 'json',
      body: '{"name":"{{ contact.name }}","items":{{ trigger.items }}}',
      form: [],
    });
    const s = node('send_text', 's', { text: 'Hi {{ contact.name }}, your order ships {{ nodes.h.body.eta }}.' });
    const e = node('end', 'e');
    t.next.next = 'h';
    h.next.success = 's';
    s.next.next = 'e';
    let seen: { url: string; body: unknown; auth: string | null } | null = null;
    const d = httpDeps((url, init) => {
      seen = { url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') };
      return new Response(JSON.stringify({ eta: 'tomorrow' }), { headers: { 'content-type': 'application/json' } });
    });
    const r = await enrollContact(db(), journeyWith({ nodes: [t, h, s, e] }), 'c1', d, {
      trigger_data: { order_id: 'A-7', items: [{ sku: 'x' }] },
    });
    expect(r.outcome).toBe('completed');
    expect(seen).toEqual({
      url: 'https://api.example.com/orders/A-7',
      body: { name: 'Asha', items: [{ sku: 'x' }] },
      auth: 'Bearer k',
    });
    expect(sent).toEqual(['text:Hi Asha, your order ships tomorrow.']);
    expect(tables.journey_events.find((x) => x.event === 'exit:success')?.data).toMatchObject({
      status: 200,
      body: { eta: 'tomorrow' },
    });
  });

  it('routes a failed request to "error", or fails the run when it is not connected', async () => {
    const make = (withError: boolean) => {
      const t = node('trigger', 't');
      const h = node('http_request', 'h', { method: 'GET', url: 'https://x.test', ...noBody });
      const ok = node('end', 'ok');
      const bad = node('add_tag', 'bad', { tag_id: 'api-down' });
      const e = node('end', 'e');
      t.next.next = 'h';
      h.next.success = 'ok';
      if (withError) h.next.error = 'bad';
      bad.next.next = 'e';
      return journeyWith({ nodes: [t, h, ok, bad, e] });
    };
    const d = httpDeps(() => new Response('nope', { status: 503 }));
    expect((await enrollContact(db(), make(true), 'c1', d)).outcome).toBe('completed');
    expect(tables.contact_tags).toEqual([expect.objectContaining({ tag_id: 'api-down' })]);

    tables.journey_enrollments = [];
    expect((await enrollContact(db(), make(false), 'c1', d)).outcome).toBe('failed');
    expect(enrollment().last_error).toMatch(/503/);
  });

  it('refuses private destinations', async () => {
    const t = node('trigger', 't');
    const h = node('http_request', 'h', { method: 'GET', url: 'http://169.254.169.254/latest', ...noBody });
    const e = node('end', 'e');
    t.next.next = 'h';
    h.next.success = 'e';
    const r = await enrollContact(db(), journeyWith({ nodes: [t, h, e] }), 'c1', {
      ...deps,
      http: async () => new Response('{}'),
    });
    expect(r.outcome).toBe('failed');
    expect(enrollment().last_error).toMatch(/not allowed/);
  });

  it('switch routes on an expression; set variable feeds later steps', async () => {
    openWindow();
    const t = node('trigger', 't');
    const v = node('set_variable', 'v', {
      assignments: [
        { key: 'tier', value: '{{ trigger.total | number }}' },
        { key: 'big', value: '{{ vars.tier }}' },
      ],
    });
    const sw = node('switch', 'sw', {
      value: '{{ vars.tier }}',
      cases: [
        { op: 'gte', value: '1000' },
        { op: 'gte', value: '100' },
      ],
    });
    const gold = node('send_text', 'gold', { text: 'Gold {{ vars.big }}' });
    const silver = node('send_text', 'silver', { text: 'Silver' });
    const other = node('end', 'other');
    const e = node('end', 'e');
    t.next.next = 'v';
    v.next.next = 'sw';
    sw.next = { case_0: 'gold', case_1: 'silver', default: 'other' };
    gold.next.next = 'e';
    silver.next.next = 'e';
    await enrollContact(db(), journeyWith({ nodes: [t, v, sw, gold, silver, other, e] }), 'c1', deps, {
      trigger_data: { total: '1500' },
    });
    expect(sent).toEqual(['text:Gold 1500']);
    expect(events()).toContain('sw:exit:case_0');
  });

  it('loops over a list, one message per item', async () => {
    openWindow();
    const t = node('trigger', 't');
    const l = node('loop', 'l', { items: '{{ trigger.items }}', max: 10 });
    const s = node('send_text', 's', { text: '{{ index }}: {{ item.name | upper }}' });
    const done = node('send_text', 'done', { text: 'All {{ nodes.l.count }} sent' });
    const e = node('end', 'e');
    t.next.next = 'l';
    l.next = { each: 's', done: 'done' };
    s.next.next = 'l';
    done.next.next = 'e';
    const r = await enrollContact(db(), journeyWith({ nodes: [t, l, s, done, e] }), 'c1', deps, {
      trigger_data: { items: [{ name: 'tea' }, { name: 'cake' }] },
    });
    expect(r.outcome).toBe('completed');
    expect(sent).toEqual(['text:0: TEA', 'text:1: CAKE', 'text:All 2 sent']);
  });

  it('runs code in the sandbox and uses its result', async () => {
    openWindow();
    const t = node('trigger', 't');
    const c = node('code', 'c', { code: 'return { total: trigger.items.reduce((s, i) => s + i.qty, 0) };' });
    const s = node('send_text', 's', { text: 'Total {{ nodes.c.total }}' });
    const e = node('end', 'e');
    t.next.next = 'c';
    c.next.success = 's';
    s.next.next = 'e';
    await enrollContact(db(), journeyWith({ nodes: [t, c, s, e] }), 'c1', deps, {
      trigger_data: { items: [{ qty: 2 }, { qty: 5 }] },
    });
    expect(sent).toEqual(['text:Total 7']);
  });

  it('keeps data across a wait and exposes the reply text', async () => {
    const t = node('trigger', 't');
    const v = node('set_variable', 'v', { assignments: [{ key: 'coupon', value: 'DIWALI20' }] });
    const w = node('wait_for_reply', 'w', { amount: 1, unit: 'hours' });
    const c = node('condition', 'c', { kind: 'expression', left: '{{ reply.text }}', op: 'contains', right: 'yes' });
    const yes = node('send_text', 'yes', { text: 'Use {{ vars.coupon }}' });
    const no = node('end', 'no');
    const e = node('end', 'e');
    t.next.next = 'v';
    v.next.next = 'w';
    w.next = { replied: 'c', timeout: 'no' };
    c.next = { yes: 'yes', no: 'no' };
    yes.next.next = 'e';
    await enrollContact(db(), journeyWith({ nodes: [t, v, w, c, yes, no, e] }), 'c1', deps);
    expect(enrollment().status).toBe('waiting');

    clock = minutes(5);
    openWindow();
    await resumeOnReply(db(), 'acct', 'c1', deps, { text: 'Yes please!' });
    expect(sent).toEqual(['text:Use DIWALI20']);
    expect(enrollment().status).toBe('completed');
  });
});

describe('inbound keyword trigger', () => {
  it('matches any message, contains, or exact', () => {
    const input = (text: string) => ({ accountId: 'a', contactId: 'c', trigger: 'inbound_message' as const, text });
    expect(triggerMatches({ trigger_config: {} }, input('anything'))).toBe(true);
    expect(triggerMatches({ trigger_config: { keyword: 'price' } }, input('What is the PRICE?'))).toBe(true);
    expect(triggerMatches({ trigger_config: { keyword: 'price', match_type: 'exact' } }, input('price list'))).toBe(false);
    expect(triggerMatches({ trigger_config: { keyword: 'price', match_type: 'exact' } }, input(' Price '))).toBe(true);
  });
});

describe('journey message log, retries and fallbacks (migration 056)', () => {
  const ecosystem = { code: 131049, title: 'This message was not delivered to maintain healthy ecosystem engagement.', details: null };
  const msgs = () => tables.journey_messages ?? [];

  it('logs each send with its Meta id and follows delivery status forward only', async () => {
    const j = journeyWith(nurtureGraph());
    await enrollContact(db(), j, 'c1', deps);
    expect(msgs()).toEqual([
      expect.objectContaining({ node_id: 'welcome', kind: 'template', status: 'sent', wa_message_id: 'wamid-1', content_text: 'welcome body' }),
    ]);
    await applyJourneyMessageStatus(db(), 'wamid-1', 'read', null, clock);
    await applyJourneyMessageStatus(db(), 'wamid-1', 'delivered', null, clock);
    expect(msgs()[0].status).toBe('read');
  });

  it('131049 schedules a retry; the tick re-sends the same template and resolves the failed one', async () => {
    const j = journeyWith(nurtureGraph());
    await enrollContact(db(), j, 'c1', deps);
    await applyJourneyMessageStatus(db(), 'wamid-1', 'failed', ecosystem, clock);
    expect(msgs()[0]).toMatchObject({ status: 'failed', error_code: 131049, next_retry_at: minutes(240).toISOString() });

    clock = minutes(30);
    await runJourneyTick(db(), deps);
    expect(sent).toEqual(['template:welcome:Asha']); // not due yet

    // The reply wait timed out at 60 min; park it far away so only the retry is due.
    enrollment().next_run_at = minutes(10_000).toISOString();
    clock = minutes(241);
    const report = await runJourneyTick(db(), deps);
    expect(report.retries).toMatchObject({ retried: 1 });
    expect(sent).toEqual(['template:welcome:Asha', 'template:welcome:Asha']);
    expect(msgs()[0]).toMatchObject({ resolved: 'retried', next_retry_at: null });
    expect(msgs()[1]).toMatchObject({ kind: 'retry', attempt: 2, status: 'sent', parent_id: msgs()[0].id });
  });

  it('drops a due retry once a newer message of the run went out', async () => {
    const j = journeyWith(nurtureGraph());
    await enrollContact(db(), j, 'c1', deps);
    msgs()[0].retry_until = minutes(100_000).toISOString(); // keep it inside its retry window
    await applyJourneyMessageStatus(db(), 'wamid-1', 'failed', ecosystem, clock);
    clock = minutes(60);
    await runJourneyTick(db(), deps); // reply timeout → waits 1 day
    clock = minutes(60 + 24 * 60);
    await runJourneyTick(db(), deps); // reminder sent (newer message), retry due too
    expect(msgs().find((m) => m.node_id === 'welcome')).toMatchObject({ resolved: 'superseded' });
    expect(sent.filter((s) => s.startsWith('template:welcome'))).toHaveLength(1);
  });

  it('re-sends an undelivered template as text when the customer writes, without consuming the reply', async () => {
    const j = journeyWith(nurtureGraph());
    await enrollContact(db(), j, 'c1', deps);
    await applyJourneyMessageStatus(db(), 'wamid-1', 'failed', ecosystem, clock);
    clock = minutes(5);
    const handled = await sendJourneyFallbacks(db(), { accountId: 'acct', contactId: 'c1', inboundText: 'hi', now: clock }, (_row, text) =>
      deps.sendText({ accountId: 'acct', userId: 'user-1', contactId: 'c1', conversationId: 'conv1' }, text)
    );
    expect(sent).toEqual(['template:welcome:Asha', 'text:welcome body']);
    expect(msgs()[0]).toMatchObject({ resolved: 'fallback_sent' });
    expect(msgs()[1]).toMatchObject({ kind: 'fallback', parent_id: msgs()[0].id, status: 'sent' });
    expect(await resumeOnReply(db(), 'acct', 'c1', deps, { text: 'hi' }, handled)).toBe(0);
    expect(enrollment()).toMatchObject({ status: 'waiting', current_node_id: 'wfr' });
  });

  it('a STOP reply ends the run instead of answering it', async () => {
    const j = journeyWith(nurtureGraph());
    await enrollContact(db(), j, 'c1', deps);
    clock = minutes(5);
    await resumeOnReply(db(), 'acct', 'c1', deps, { text: 'STOP' });
    expect(enrollment()).toMatchObject({ status: 'exited', last_error: 'Contact opted out (STOP)' });
    expect(tables.contact_tags).toEqual([]);
  });

  it('an exit tag (e.g. paid) stops the run before its next step', async () => {
    const g = nurtureGraph();
    (g.nodes[0].config as { exit_tag_ids?: string[] }).exit_tag_ids = ['paid'];
    const j = journeyWith(g);
    await enrollContact(db(), j, 'c1', deps);
    tables.contact_tags.push({ id: 'p', contact_id: 'c1', tag_id: 'paid' });
    clock = minutes(60);
    await runJourneyTick(db(), deps);
    expect(enrollment().status).toBe('exited');
    expect(sent).toEqual(['template:welcome:Asha']);
  });

  it('parses Meta error codes and plans retries inside the allowed window', () => {
    expect(metaErrorCode('(#132001) Template name does not exist')).toBe(132001);
    expect(metaErrorCode('[131049] not delivered')).toBe(131049);
    expect(metaErrorCode('Meta API error: 500')).toBeNull();
    const base = { kind: 'template' as const, attempt: 1, errorCode: 131049, now: T0 };
    expect(planRetry({ ...base, retryUntil: null })).toBe(minutes(240).toISOString());
    expect(planRetry({ ...base, retryUntil: minutes(120).toISOString() })).toBeNull();
    expect(planRetry({ ...base, attempt: 3, retryUntil: null })).toBeNull();
    expect(planRetry({ ...base, errorCode: 132001, retryUntil: null })).toBeNull();
    expect(planRetry({ ...base, kind: 'text', retryUntil: null })).toBeNull();
  });
});

describe('contact_created source filter', () => {
  const input = (source?: 'api' | 'whatsapp') => ({ accountId: 'acct', contactId: 'c1', trigger: 'contact_created' as const, source });
  it('any source by default; "api" / "whatsapp" only match that source', () => {
    expect(triggerMatches({ trigger_config: {} }, input('whatsapp'))).toBe(true);
    expect(triggerMatches({ trigger_config: { contact_source: 'any' } }, input('api'))).toBe(true);
    expect(triggerMatches({ trigger_config: { contact_source: 'api' } }, input('api'))).toBe(true);
    expect(triggerMatches({ trigger_config: { contact_source: 'api' } }, input('whatsapp'))).toBe(false);
    expect(triggerMatches({ trigger_config: { contact_source: 'whatsapp' } }, input('api'))).toBe(false);
  });
});

describe('stop a run by hand', () => {
  it('stops a waiting run so nothing else is sent, and refuses finished or foreign runs', async () => {
    const j = journeyWith(nurtureGraph());
    await enrollContact(db(), j, 'c1', deps);
    const id = String(enrollment().id);
    const args = { enrollmentId: id, journeyId: 'j1', accountId: 'acct', reason: 'Stopped by Asha', now: minutes(5) };

    expect(await stopEnrollment(db(), { ...args, accountId: 'other' })).toBe('not_found');
    expect(await stopEnrollment(db(), args)).toBe('stopped');
    expect(enrollment()).toMatchObject({ status: 'exited', last_error: 'Stopped by Asha' });
    expect(events()).toContain('wfr:exited');

    clock = minutes(10);
    expect(await resumeOnReply(db(), 'acct', 'c1', deps, { text: 'hi' })).toBe(0);
    clock = minutes(24 * 60 * 3);
    await runJourneyTick(db(), deps);
    expect(sent).toEqual(['template:welcome:Asha']);
    expect(await stopEnrollment(db(), args)).toBe('finished');
  });
});
