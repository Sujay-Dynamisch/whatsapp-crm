import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Journeys are on for the test account.
vi.mock('@/lib/features-server', () => ({ accountHasFeature: async () => true }));

import {
  DAY_END_HOUR,
  DAY_START_HOUR,
  NURTURE_HOUR,
  TAGS,
  buildJourney,
  realignedNudgeTime,
  realignedNurtureTime,
  type TagIds,
} from '../../../scripts/swapnil/journey-graph';
import { triggerColumns } from './api';
import { dispatchJourneyInbound, dispatchJourneyTrigger, restartJourneysOnReregistration } from './dispatch';
import { runJourneyTick, type JourneyDeps, type JourneyRow } from './engine';
import { validateGraph, type JourneyGraph, type NodeConfigs } from './graph';
import { isUnsubscribeText } from '@/lib/contacts/unsubscribe';

// ============================================================
// End-to-end runs of Swapnil Gautam's webinar journey (the graph the
// seed script writes), against an in-memory database and a simulated
// clock, checked against "Swapnil Gautam_Lead Lifecycle Flow.pdf" and
// SG_WhatsApp_Templates.pdf.
// ============================================================

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let seq = 0;
let clock: Date;

function fakeDb(): SupabaseClient {
  return {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const preds: ((r: Row) => boolean)[] = [];
      let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
      let patch: Row | null = null;
      let inserted: Row[] = [];
      let head = false;
      let single = false;
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
          return { data: single ? (data?.[0] ?? null) : data, error: null };
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
        const data = hit.slice(0, limitN).map((r) => structuredClone(r));
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
        ilike: (c: string, v: string) => (preds.push((r) => String(r[c] ?? '').toLowerCase() === v.toLowerCase()), b),
        limit: (n: number) => ((limitN = n), b),
        order: () => b,
        single: () => ((single = true), b),
        maybeSingle: () => ((single = true), b),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      };
      return b;
    },
    rpc: async (fn: string) => {
      if (fn === 'claim_scheduled_journeys') return { data: [], error: null };
      if (fn !== 'claim_journey_enrollments') throw new Error(fn);
      const nowIso = clock.toISOString();
      const due = (tables.journey_enrollments ?? []).filter((e) => e.status === 'waiting' && String(e.next_run_at) <= nowIso);
      for (const e of due) Object.assign(e, { status: 'active', locked_at: nowIso });
      return { data: due.map((e) => structuredClone(e)), error: null };
    },
  } as unknown as SupabaseClient;
}
const db = () => fakeDb();

// ------------------------------------------------------------------
// IST helpers
// ------------------------------------------------------------------
const H = 3_600_000;
const IST = 5.5 * H;
/** "2026-11-02 10:00" IST → Date. */
const ist = (s: string) => new Date(Date.parse(`${s.replace(' ', 'T')}:00+05:30`));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');
/** Date → "Mon 02 14:00" (IST). */
const label = (d: Date) => {
  const x = new Date(d.getTime() + IST);
  return `${DAYS[x.getUTCDay()]} ${pad(x.getUTCDate())} ${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`;
};
const istHour = (d: Date) => new Date(d.getTime() + IST).getUTCHours() + new Date(d.getTime() + IST).getUTCMinutes() / 60;

// ------------------------------------------------------------------
// Side effects + Meta behaviour
// ------------------------------------------------------------------
interface Sent {
  at: Date;
  kind: 'template' | 'text';
  name: string;
  params?: string[];
  text?: string;
}
let sent: Sent[];
/** Return an Error to make Meta refuse this template send. */
let metaRule: (name: string, at: Date) => Error | null;

const TAG_IDS = Object.fromEntries(TAGS.map((t) => [t, `tag-${t}`])) as TagIds;
const TAG_NAMES = new Map<string, string>([...TAGS.map((t) => [`tag-${t}`, t] as [string, string]), ['tag-unsub', 'unsubscribe']]);
const LINKS = { webinar: 'https://zoom.example/webinar', pay: 'https://pay.example/revibe' };

const deps: JourneyDeps = {
  now: () => clock,
  sendTemplate: async (_ctx, cfg) => {
    const err = metaRule(cfg.template_name, clock);
    if (err) throw err;
    sent.push({ at: clock, kind: 'template', name: cfg.template_name, params: cfg.params ?? [] });
    return { whatsapp_message_id: `wamid-${sent.length}`, content_text: `${cfg.template_name} body` };
  },
  sendText: async (_ctx, text) => {
    sent.push({ at: clock, kind: 'text', name: 'text', text });
    return { whatsapp_message_id: `wamid-${sent.length}` };
  },
  addTag: async (ctx, tagId) => addTag(ctx.contactId, tagId),
};

function addTag(contactId: string, tagId: string) {
  if (tables.contact_tags.some((r) => r.contact_id === contactId && r.tag_id === tagId)) return;
  tables.contact_tags.push({ id: `ct-${++seq}`, contact_id: contactId, tag_id: tagId, tags: { name: TAG_NAMES.get(tagId) ?? tagId } });
}
const hasTag = (name: (typeof TAGS)[number] | 'unsubscribe', contactId = 'c1') =>
  tables.contact_tags.some((r) => r.contact_id === contactId && TAG_NAMES.get(String(r.tag_id)) === name);

// ------------------------------------------------------------------
// Journey + driver
// ------------------------------------------------------------------
function journey(): JourneyRow {
  const graph = buildJourney(TAG_IDS, 'owner');
  const settings = graph.nodes.find((n) => n.id === 'settings')!;
  (settings.config as NodeConfigs['set_variable']).assignments = [
    { key: 'webinar_link', value: LINKS.webinar },
    { key: 'payment_link', value: LINKS.pay },
    { key: 'testimonials_text', value: 'Testimonials: Priya lost 8 kg; Rahul got fit.' },
    { key: 'faq_text', value: 'FAQ: instalments are available.' },
  ];
  const row = {
    id: 'j1',
    account_id: 'acct',
    name: 'Webinar Funnel — Swapnil Gautam',
    status: 'active',
    ...triggerColumns(graph),
    graph,
    allow_reentry: false,
    created_by: 'owner',
  } as unknown as JourneyRow;
  tables.journeys = [row as unknown as Row];
  return row;
}

/** A lead registers on the website at `when` (IST): contact created + journey started. */
async function register(when: string, contactId = 'c1') {
  clock = ist(when);
  const contact = tables.contacts.find((c) => c.id === contactId)!;
  contact.created_at_ist = `${when}:00`;
  await dispatchJourneyTrigger(
    db(),
    { accountId: 'acct', contactId, trigger: 'contact_created', source: 'api', data: { source: 'api', registration_id: `reg-${when}` } },
    deps
  );
}

/** Earliest pending engine event (a wait ending or a template retry). */
function nextDue(): number | null {
  const times = [
    ...tables.journey_enrollments.filter((e) => e.status === 'waiting').map((e) => Date.parse(String(e.next_run_at))),
    ...(tables.journey_messages ?? [])
      .filter((m) => m.status === 'failed' && !m.resolved && m.next_retry_at)
      .map((m) => Date.parse(String(m.next_retry_at))),
  ].filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}

/** Let time pass to `when` (IST), running the every-minute tick whenever something is due (10 s late). */
async function runUntil(when: string | Date) {
  const target = typeof when === 'string' ? ist(when) : when;
  for (let guard = 0; guard < 500; guard++) {
    const due = nextDue();
    if (due === null || due > target.getTime()) break;
    clock = new Date(Math.max(clock.getTime(), due) + 10_000);
    const report = await runJourneyTick(db(), deps);
    expect(report.errors).toEqual([]);
  }
  if (clock < target) clock = target;
}

/** The lead sends a WhatsApp message at `when` (IST) — same order as the webhook. */
async function reply(text: string, when?: string, contactId = 'c1') {
  if (when) await runUntil(when);
  const conv = tables.conversations.find((c) => c.contact_id === contactId)!;
  tables.messages.push({ id: `m-${++seq}`, conversation_id: conv.id, sender_type: 'customer', created_at: clock.toISOString() });
  conv.last_customer_message_at = clock.toISOString();
  await dispatchJourneyInbound(db(), { accountId: 'acct', contactId, text }, deps);
  if (isUnsubscribeText(text)) addTag(contactId, 'tag-unsub');
}

const run = (contactId = 'c1') =>
  tables.journey_enrollments.filter((e) => e.contact_id === contactId).at(-1) as Row & { status: string; current_node_id: string };
/** "Mon 02 14:00 sg_webinar_reminder" lines. */
const log = (from = 0) => sent.slice(from).map((s) => `${label(s.at)} ${s.kind === 'text' ? `text:${s.text!.split('\n')[0]}` : s.name}`);
const templates = (name: string) => sent.filter((s) => s.name === name);

beforeEach(() => {
  seq = 0;
  sent = [];
  metaRule = () => null;
  clock = ist('2026-11-01 00:00');
  tables = {
    contacts: [
      { id: 'c1', account_id: 'acct', name: 'Asha', phone: '+919800000001' },
      { id: 'c2', account_id: 'acct', name: 'Ravi', phone: '+919800000002' },
    ],
    conversations: [
      { id: 'conv1', account_id: 'acct', contact_id: 'c1', last_customer_message_at: null },
      { id: 'conv2', account_id: 'acct', contact_id: 'c2', last_customer_message_at: null },
    ],
    profiles: [{ user_id: 'owner', account_id: 'acct' }],
    messages: [],
    contact_tags: [],
    journey_enrollments: [],
    journey_events: [],
    journey_messages: [],
    message_templates: [
      { id: 'tpl-b', user_id: 'owner', account_id: 'acct', name: 'sg_nurture_postwebinar', language: 'en_US', body_text: 'Hi {{1}}, still thinking?' },
    ],
  };
  journey();
});

// ============================================================
// The graph itself
// ============================================================
describe('graph', () => {
  it('is valid, under the step limit, and every template gets the PDF’s number of variables', () => {
    const g: JourneyGraph = buildJourney(TAG_IDS, 'owner');
    expect(validateGraph(g)).toEqual([]);
    expect(g.nodes.length).toBeLessThanOrEqual(100);
    // {{n}} count per template in SG_WhatsApp_Templates.pdf.
    const expected: Record<string, number> = {
      sg_webinar_confirmation: 4,
      sg_webinar_reminder: 5,
      sg_post_webinar_checkin: 1,
      sg_webinar_reinvite: 4,
      sg_testimonial_reprompt: 1,
      sg_nurture_prewebinar: 4,
      sg_nurture_postwebinar: 1,
      sg_nurture_coldlead: 1,
      sg_nurture_payment: 2,
    };
    const used = g.nodes.filter((n) => n.type === 'send_template');
    expect(new Set(used.map((n) => (n.config as NodeConfigs['send_template']).template_name))).toEqual(new Set(Object.keys(expected)));
    for (const n of used) {
      const c = n.config as NodeConfigs['send_template'];
      expect(c.params?.length, c.template_name).toBe(expected[c.template_name]);
    }
  });

  it('stops the run on paid / manually_closed (kill switch)', () => {
    const t = buildJourney(TAG_IDS, 'owner').nodes.find((n) => n.type === 'trigger')!.config as NodeConfigs['trigger'];
    expect(t.exit_tag_ids).toEqual([TAG_IDS.paid, TAG_IDS.manually_closed]);
    expect(t.contact_source).toBe('api');
  });
});

// ============================================================
// Registration → Msg 1–3 → check-in, per cutoff rule
// ============================================================
describe('registration schedule (cutoffs: weekdays 2 PM, weekends 10 AM)', () => {
  const firstFour = async (when: string, until: string) => {
    await register(when);
    await runUntil(until);
    return log().slice(0, 4);
  };

  it('weekday before 2 PM → same-day 8 PM webinar; Msg 1 at once, Msg 2 2 PM, Msg 3 7 PM, check-in 7 AM', async () => {
    expect(await firstFour('2026-11-02 10:00', '2026-11-03 08:00')).toEqual([
      'Mon 02 10:00 sg_webinar_confirmation',
      'Mon 02 14:00 sg_webinar_reminder',
      'Mon 02 19:00 sg_webinar_reminder',
      'Tue 03 07:00 sg_post_webinar_checkin',
    ]);
    const [msg1, msg2, msg3] = sent;
    expect(msg1.params).toEqual(['Asha', 'Mon, 2 Nov 2026', '8:00 PM IST', LINKS.webinar]);
    expect(msg2.params).toEqual(['Asha', 'coming up tonight at 8:00 PM', 'Mon, 2 Nov 2026', '8:00 PM IST', LINKS.webinar]);
    expect(msg3.params).toEqual(['Asha', 'starting in 1 hour', 'Mon, 2 Nov 2026', '8:00 PM IST', LINKS.webinar]);
  });

  it('registers at 12 AM → Msg 1 goes out at 12 AM (not held for daytime)', async () => {
    expect(await firstFour('2026-11-03 00:00', '2026-11-04 08:00')).toEqual([
      'Tue 03 00:00 sg_webinar_confirmation',
      'Tue 03 14:00 sg_webinar_reminder',
      'Tue 03 19:00 sg_webinar_reminder',
      'Wed 04 07:00 sg_post_webinar_checkin',
    ]);
  });

  it('weekday after 2 PM → next day’s 8 PM webinar', async () => {
    expect(await firstFour('2026-11-03 15:30', '2026-11-05 08:00')).toEqual([
      'Tue 03 15:30 sg_webinar_confirmation',
      'Wed 04 14:00 sg_webinar_reminder',
      'Wed 04 19:00 sg_webinar_reminder',
      'Thu 05 07:00 sg_post_webinar_checkin',
    ]);
    expect(sent[0].params?.[1]).toBe('Wed, 4 Nov 2026');
  });

  it('Friday after 2 PM → Saturday’s 3 PM webinar with weekend timings', async () => {
    expect(await firstFour('2026-11-06 16:00', '2026-11-08 08:00')).toEqual([
      'Fri 06 16:00 sg_webinar_confirmation',
      'Sat 07 11:00 sg_webinar_reminder',
      'Sat 07 14:00 sg_webinar_reminder',
      'Sun 08 07:00 sg_post_webinar_checkin',
    ]);
    expect(sent[0].params?.slice(1, 3)).toEqual(['Sat, 7 Nov 2026', '3:00 PM IST']);
    expect(sent[1].params?.[1]).toBe('this afternoon at 3:00 PM');
  });

  it('weekend before 10 AM → same-day 3 PM webinar', async () => {
    expect(await firstFour('2026-11-07 09:00', '2026-11-08 08:00')).toEqual([
      'Sat 07 09:00 sg_webinar_confirmation',
      'Sat 07 11:00 sg_webinar_reminder',
      'Sat 07 14:00 sg_webinar_reminder',
      'Sun 08 07:00 sg_post_webinar_checkin',
    ]);
  });

  it('Sunday after 10 AM → Monday’s 8 PM webinar with weekday timings', async () => {
    expect(await firstFour('2026-11-08 12:00', '2026-11-10 08:00')).toEqual([
      'Sun 08 12:00 sg_webinar_confirmation',
      'Mon 09 14:00 sg_webinar_reminder',
      'Mon 09 19:00 sg_webinar_reminder',
      'Tue 10 07:00 sg_post_webinar_checkin',
    ]);
    expect(sent[0].params?.slice(1, 3)).toEqual(['Mon, 9 Nov 2026', '8:00 PM IST']);
  });

  it('tags webinar_registered', async () => {
    await register('2026-11-02 10:00');
    expect(hasTag('webinar_registered')).toBe(true);
  });
});

// ============================================================
// No response → one re-invite → nurture stage by drop-off point
// ============================================================
describe('no response → re-invite → Stage A/B/C at 11 AM every 2nd day → CLOSED-LOST on day 15', () => {
  const NURTURE_DATES_FROM_FRI_06 = ['Fri 06', 'Sun 08', 'Tue 10', 'Thu 12', 'Sat 14', 'Mon 16', 'Wed 18', 'Fri 20'];

  it('never replied → Stage A (sg_nurture_prewebinar) × 8, closed_lost Sat 21 at 11 AM', async () => {
    await register('2026-11-02 10:00');
    await runUntil('2026-11-25 00:00');
    expect(log()).toEqual([
      'Mon 02 10:00 sg_webinar_confirmation',
      'Mon 02 14:00 sg_webinar_reminder',
      'Mon 02 19:00 sg_webinar_reminder',
      'Tue 03 07:00 sg_post_webinar_checkin',
      // No reply in 24h → next webinar link, reminders, check-in again.
      'Wed 04 07:00 sg_webinar_reinvite',
      'Wed 04 14:00 sg_webinar_reminder',
      'Wed 04 19:00 sg_webinar_reminder',
      'Thu 05 07:00 sg_post_webinar_checkin',
      ...NURTURE_DATES_FROM_FRI_06.map((d) => `${d} 11:00 sg_nurture_prewebinar`),
    ]);
    expect(templates('sg_webinar_reinvite')[0].params?.[1]).toBe('Wed, 4 Nov 2026');
    // Stage A re-invites to the next upcoming webinar (11 AM weekday → that night).
    expect(templates('sg_nurture_prewebinar')[0].params).toEqual(['Asha', 'Fri, 6 Nov 2026', '8:00 PM IST', LINKS.webinar]);
    expect(templates('sg_nurture_prewebinar')[1].params?.slice(1, 3)).toEqual(['Mon, 9 Nov 2026', '8:00 PM IST']); // Sun 11 AM → Mon
    expect(hasTag('closed_lost')).toBe(true);
    expect(run()).toMatchObject({ status: 'completed', current_node_id: 'end' });
    const lost = tables.journey_events.filter((e) => e.node_id === 'tag_lost' && e.event === 'entered');
    expect(lost).toHaveLength(1);
    expect(label(clock)).toBe('Wed 25 00:00');
    // Closed-lost was applied on day 15 (Sat 21) at 11 AM.
    expect(label(new Date(String(run().completed_at)))).toBe('Sat 21 11:00');
  });

  it('replied to Msg 1 but never answered the check-in → Stage B (sg_nurture_postwebinar)', async () => {
    await register('2026-11-02 10:00');
    await reply('ok thanks', '2026-11-02 10:05');
    expect(run().status).toBe('waiting'); // a reply during a timer wait doesn't change the flow
    await runUntil('2026-11-25 00:00');
    expect(log().slice(8)).toEqual(NURTURE_DATES_FROM_FRI_06.map((d) => `${d} 11:00 sg_nurture_postwebinar`));
    expect(templates('sg_nurture_prewebinar')).toHaveLength(0);
    expect(hasTag('closed_lost')).toBe(true);
  });

  it('chose 3 (attend again), then went quiet → next session, then Stage C (sg_nurture_coldlead)', async () => {
    await register('2026-11-02 10:00');
    await reply('3', '2026-11-03 09:00');
    expect(log().at(-1)).toBe('Tue 03 09:00 sg_webinar_reinvite');
    expect(templates('sg_webinar_reinvite')[0].params?.slice(1, 3)).toEqual(['Tue, 3 Nov 2026', '8:00 PM IST']);
    await runUntil('2026-11-30 00:00');
    expect(log(4)).toEqual([
      'Tue 03 09:00 sg_webinar_reinvite',
      'Tue 03 14:00 sg_webinar_reminder',
      'Tue 03 19:00 sg_webinar_reminder',
      'Wed 04 07:00 sg_post_webinar_checkin',
      // No answer → the automatic re-invite (once), then nurture.
      'Thu 05 07:00 sg_webinar_reinvite',
      'Thu 05 14:00 sg_webinar_reminder',
      'Thu 05 19:00 sg_webinar_reminder',
      'Fri 06 07:00 sg_post_webinar_checkin',
      ...['Sat 07', 'Mon 09', 'Wed 11', 'Fri 13', 'Sun 15', 'Tue 17', 'Thu 19', 'Sat 21'].map((d) => `${d} 11:00 sg_nurture_coldlead`),
    ]);
    expect(hasTag('closed_lost')).toBe(true);
  });

  it('“Couldn’t attend” button works like 3', async () => {
    await register('2026-11-02 10:00');
    await reply('Couldn’t attend', '2026-11-03 09:00');
    expect(log().at(-1)).toBe('Tue 03 09:00 sg_webinar_reinvite');
  });

  it('unrecognised answer → asked for 1–4; still quiet → Stage C', async () => {
    await register('2026-11-02 10:00');
    await reply('hmm', '2026-11-03 09:00');
    expect(log().at(-1)).toBe('Tue 03 09:00 text:Please reply with 1, 2, 3 or 4 so I can help you with your next step. 🙏');
    await runUntil('2026-11-30 00:00');
    expect(templates('sg_nurture_coldlead')).toHaveLength(8);
    expect(templates('sg_nurture_prewebinar')).toHaveLength(0);
  });

  it('every nurture send is at 11 AM IST, 2 days apart', async () => {
    await register('2026-11-02 10:00');
    await runUntil('2026-11-25 00:00');
    const n = templates('sg_nurture_prewebinar');
    for (const s of n) expect(label(s.at).slice(-5)).toBe(`${NURTURE_HOUR}:00`);
    for (let i = 1; i < n.length; i++) expect(Math.round((n[i].at.getTime() - n[i - 1].at.getTime()) / H)).toBe(48);
  });
});

// ============================================================
// Conversion menu
// ============================================================
describe('conversion menu', () => {
  it('2 / testimonials → testimonials + disclaimer → 24h → T5 re-prompt once → 48h → Stage C', async () => {
    await register('2026-11-02 10:00');
    await reply('2', '2026-11-03 08:00');
    expect(sent.at(-1)!.text).toBe('Testimonials: Priya lost 8 kg; Rahul got fit.\n\n_Results may vary from person to person._');
    await runUntil('2026-11-25 00:00');
    expect(log(4)).toEqual([
      'Tue 03 08:00 text:Testimonials: Priya lost 8 kg; Rahul got fit.',
      'Wed 04 08:00 sg_testimonial_reprompt',
      ...['Fri 06', 'Sun 08', 'Tue 10', 'Thu 12', 'Sat 14', 'Mon 16', 'Wed 18', 'Fri 20'].map((d) => `${d} 11:00 sg_nurture_coldlead`),
    ]);
    expect(templates('sg_testimonial_reprompt')).toHaveLength(1);
  });

  it('T5 “Request Callback” → handoff', async () => {
    await register('2026-11-02 10:00');
    await reply('Want to see testimonials', '2026-11-03 08:00');
    await reply('Request Callback', '2026-11-04 10:00');
    expect(hasTag('callback_requested')).toBe(true);
    expect(run()).toMatchObject({ status: 'completed' });
  });

  it('4 / Request a callback → callback_requested tag, assigned to Swapnil, confirmation, automation stops', async () => {
    await register('2026-11-02 10:00');
    await reply('Request a callback', '2026-11-03 08:00');
    expect(hasTag('callback_requested')).toBe(true);
    expect(tables.conversations.find((c) => c.id === 'conv1')!.assigned_agent_id).toBe('owner');
    expect(sent.at(-1)!.text).toBe('Thank you, Asha! 🙏 My team will call you shortly.');
    expect(run()).toMatchObject({ status: 'completed' });
    const count = sent.length;
    await runUntil('2026-11-30 00:00');
    expect(sent.length).toBe(count); // no nurture after a handoff
  });

  it('typed “CALLBACK” also hands off', async () => {
    await register('2026-11-02 10:00');
    await reply('CALLBACK', '2026-11-03 08:00');
    expect(hasTag('callback_requested')).toBe(true);
  });
});

// ============================================================
// Payment link → daytime nudges inside the 24h window → Stage D
// ============================================================
describe('payment link → nudges → Stage D', () => {
  const D_DATES = ['Thu 05', 'Sat 07', 'Mon 09', 'Wed 11', 'Fri 13', 'Sun 15', 'Tue 17', 'Thu 19'];

  it('“Ready to Join” at 8:59 PM → link at once; nudges held to daytime (9 AM, 2:59 PM); Stage D at 11 AM; lost day 15', async () => {
    await register('2026-11-02 10:00');
    await reply('Ready to Join', '2026-11-03 20:59');
    expect(log().at(-1)).toBe('Tue 03 20:59 text:Great decision, Asha! 🎉');
    expect(sent.at(-1)!.text).toContain(LINKS.pay);
    expect(hasTag('payment_link_sent')).toBe(true);
    await runUntil('2026-11-25 00:00');
    expect(log(5)).toEqual([
      'Wed 04 09:00 text:Hi Asha, just checking in 😊 Your spot in Revibe is still open.',
      'Wed 04 14:59 text:Hi Asha, your payment link is still active:',
      ...D_DATES.map((d) => `${d} 11:00 sg_nurture_payment`),
    ]);
    expect(templates('sg_nurture_payment')[0].params).toEqual(['Asha', LINKS.pay]);
    expect(hasTag('closed_lost')).toBe(true);
  });

  it('“1” at 3 AM → nudge 1 at 9 AM; nudge 2 would fall outside the 24h window → skipped, straight to Stage D', async () => {
    await register('2026-11-02 10:00');
    await reply('1', '2026-11-04 03:00'); // within the 24h after the 7 AM check-in
    await runUntil('2026-11-06 00:00');
    expect(log(4)).toEqual([
      'Wed 04 03:00 text:Great decision, Asha! 🎉',
      'Wed 04 09:00 text:Hi Asha, just checking in 😊 Your spot in Revibe is still open.',
      'Thu 05 11:00 sg_nurture_payment',
    ]);
    expect(run().status).toBe('waiting');
  });

  it('“1” at 10 AM → nudges at 4 PM and 9 AM next day (both inside the window)', async () => {
    await register('2026-11-02 10:00');
    await reply('1', '2026-11-03 10:00');
    await runUntil('2026-11-05 00:00');
    expect(log(5)).toEqual([
      'Tue 03 16:00 text:Hi Asha, just checking in 😊 Your spot in Revibe is still open.',
      'Wed 04 09:00 text:Hi Asha, your payment link is still active:',
      'Wed 04 11:00 sg_nurture_payment',
    ]);
  });

  it('nudges never go out at night or after the 24h window, whenever the lead taps Join', async () => {
    for (let hour = 0; hour < 24; hour++) {
      tables.journey_enrollments = [];
      tables.journey_events = [];
      tables.journey_messages = [];
      tables.messages = [];
      tables.contact_tags = [];
      sent = [];
      await register('2026-11-02 10:00');
      const at = new Date(ist('2026-11-03 07:00').getTime() + (hour + 0.5) * H); // 07:30 Tue … 06:30 Wed
      await runUntil(at);
      await reply('1');
      const linkAt = clock.getTime();
      await runUntil(new Date(linkAt + 3 * 24 * H));
      const nudges = sent.filter((s) => s.kind === 'text' && /checking in|still active/.test(s.text!));
      expect(nudges.length, `join at ${label(new Date(linkAt))}`).toBeGreaterThanOrEqual(1);
      for (const s of nudges) {
        expect(istHour(s.at), label(s.at)).toBeGreaterThanOrEqual(DAY_START_HOUR);
        expect(istHour(s.at), label(s.at)).toBeLessThan(DAY_END_HOUR);
        expect(s.at.getTime() - linkAt, label(s.at)).toBeLessThan(24 * H);
      }
      expect(run().status).toBe('waiting'); // never failed; parked in Stage D
      expect(templates('sg_nurture_payment').length).toBeGreaterThanOrEqual(1);
    }
  }, 120_000);

  it('24h window found closed before a nudge → nudge skipped, run continues to Stage D (never fails)', async () => {
    await register('2026-11-02 10:00');
    await reply('1', '2026-11-03 10:00');
    // The window is older than we planned for (e.g. clock skew): last message 23h ago.
    tables.conversations[0].last_customer_message_at = new Date(clock.getTime() - 23 * H).toISOString();
    await runUntil('2026-11-05 00:00');
    expect(sent.filter((s) => s.kind === 'text' && /checking in|still active/.test(s.text!))).toHaveLength(0);
    expect(log().at(-1)).toBe('Wed 04 11:00 sg_nurture_payment');
    expect(run().status).toBe('waiting');
  });

  it('Stage D “Complete Payment” → link again; “I Have a Question” → FAQ + handoff', async () => {
    await register('2026-11-02 10:00');
    await reply('1', '2026-11-03 10:00');
    await reply('Complete Payment', '2026-11-04 12:00');
    expect(sent.at(-1)!.text).toContain('Great decision');
    await reply('I Have a Question', '2026-11-04 13:00');
    expect(sent.at(-2)!.text).toBe('FAQ: instalments are available.\n\nMy team will also reach out to you personally.');
    expect(hasTag('callback_requested')).toBe(true);
    expect(run().status).toBe('completed');
  });

  it('Stage D “Not Proceeding” → manually_closed, goodbye, nothing more', async () => {
    await register('2026-11-02 10:00');
    await reply('1', '2026-11-03 10:00');
    await reply('Not Proceeding', '2026-11-04 12:00');
    expect(hasTag('manually_closed')).toBe(true);
    expect(sent.at(-1)!.text).toContain("I won't send further messages");
    const count = sent.length;
    await runUntil('2026-11-30 00:00');
    expect(sent.length).toBe(count);
  });

  it('payment received (paid tag) during Stage D → run stops, no more messages (CLOSED-WON)', async () => {
    await register('2026-11-02 10:00');
    await reply('1', '2026-11-03 10:00');
    await runUntil('2026-11-04 12:00');
    addTag('c1', TAG_IDS.paid);
    const count = sent.length;
    await runUntil('2026-11-30 00:00');
    expect(sent.length).toBe(count);
    expect(run()).toMatchObject({ status: 'exited', last_error: 'Stopped: contact has the "paid" tag' });
  });
});

// ============================================================
// Global overrides
// ============================================================
describe('STOP / kill switch', () => {
  it('STOP during nurture → opted out at once, nothing more', async () => {
    await register('2026-11-02 10:00');
    await runUntil('2026-11-07 00:00');
    await reply('STOP');
    expect(run()).toMatchObject({ status: 'exited', last_error: 'Contact opted out (STOP)' });
    const count = sent.length;
    await runUntil('2026-11-30 00:00');
    expect(sent.length).toBe(count);
  });

  it('STOP before Msg 2 (while no reply is awaited) → Msg 2 is never sent', async () => {
    await register('2026-11-02 10:00');
    await reply('stop', '2026-11-02 11:00');
    await runUntil('2026-11-30 00:00');
    expect(log()).toEqual(['Mon 02 10:00 sg_webinar_confirmation']);
    expect(run().status).toBe('exited');
  });

  it('manually_closed (kill switch) mid-nurture → stops', async () => {
    await register('2026-11-02 10:00');
    await runUntil('2026-11-09 00:00');
    addTag('c1', TAG_IDS.manually_closed);
    const count = sent.length;
    await runUntil('2026-11-30 00:00');
    expect(sent.length).toBe(count);
    expect(run().status).toBe('exited');
  });

  it('a nurture reply re-opens the menu (“I’m Ready to Join” → payment link)', async () => {
    await register('2026-11-02 10:00');
    await reply("I'm Ready to Join", '2026-11-06 12:00');
    expect(sent.at(-1)!.text).toContain('Great decision');
  });
});

// ============================================================
// Meta refusing messages
// ============================================================
describe('Meta delivery failures never stop the nurture', () => {
  const metaError = (code: number) => new Error(`(#${code}) Meta refused the message`);

  it('131049 (marketing limit) → one retry at 3 PM, none at night, next nurture still goes out', async () => {
    metaRule = (name, at) =>
      name === 'sg_nurture_prewebinar' && label(at).startsWith('Fri 06') ? metaError(131049) : null;
    await register('2026-11-02 10:00');
    await runUntil('2026-11-08 12:00');
    const tries = (tables.journey_messages ?? []).filter((m) => m.template_name === 'sg_nurture_prewebinar');
    // 11:00 (failed) → retry 15:00 (failed) → no 23:00 retry (past 9 PM).
    expect(tries.map((m) => `${label(new Date(String(m.created_at)))} ${m.kind}:${m.status}`)).toEqual([
      'Fri 06 11:00 template:failed',
      'Fri 06 15:00 retry:failed',
      'Sun 08 11:00 template:sent',
    ]);
    expect(run().status).toBe('waiting');
  });

  it('131049 then the retry gets through at 3 PM', async () => {
    let first = true;
    metaRule = (name) => {
      if (name === 'sg_nurture_prewebinar' && first) {
        first = false;
        return metaError(131049);
      }
      return null;
    };
    await register('2026-11-02 10:00');
    await runUntil('2026-11-07 00:00');
    expect(log().filter((l) => l.includes('prewebinar'))).toEqual(['Fri 06 15:00 sg_nurture_prewebinar']);
  });

  it('template missing / not approved (132001) on every send → no retries, all 8 attempted, still closed-lost', async () => {
    metaRule = (name) => (name.startsWith('sg_nurture_') ? metaError(132001) : null);
    await register('2026-11-02 10:00');
    await runUntil('2026-11-25 00:00');
    const attempts = (tables.journey_messages ?? []).filter((m) => m.template_name === 'sg_nurture_prewebinar');
    expect(attempts).toHaveLength(8);
    expect(attempts.every((m) => m.kind === 'template' && m.status === 'failed' && !m.next_retry_at)).toBe(true);
    expect(hasTag('closed_lost')).toBe(true);
    expect(run().status).toBe('completed');
  });

  it('a failed nurture is sent as text when the lead writes in that day (24h window open)', async () => {
    metaRule = (name, at) => (name === 'sg_nurture_postwebinar' && label(at).startsWith('Fri 06') ? metaError(131049) : null);
    await register('2026-11-02 10:00');
    await reply('ok', '2026-11-02 10:05'); // → Stage B
    await runUntil('2026-11-06 16:00'); // 11:00 + 15:00 retry failed
    await reply('hello', '2026-11-06 18:00');
    const fallback = (tables.journey_messages ?? []).filter((m) => m.kind === 'fallback');
    expect(fallback).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ kind: 'text', text: 'Hi Asha, still thinking?' });
  });

  it('Meta refusing the check-in or reminders does not stop the run either', async () => {
    metaRule = (name) => (name === 'sg_webinar_reminder' || name === 'sg_post_webinar_checkin' ? metaError(131026) : null);
    await register('2026-11-02 10:00');
    await runUntil('2026-11-25 00:00');
    expect(templates('sg_nurture_prewebinar')).toHaveLength(8);
    expect(hasTag('closed_lost')).toBe(true);
  });
});

// ============================================================
// Runs already in progress when this version ships
// ============================================================
describe('runs from before this version', () => {
  const oldContext = (extra: Row = {}) => ({
    trigger: 'contact_created',
    trigger_data: { type: 'contact_created' },
    vars: { webinar_link: LINKS.webinar, payment_link: LINKS.pay, faq_text: 'FAQ', testimonials_text: 'T', auto_reinvite: 'yes' },
    nodes: { nurture_days: [1, 2, 3, 4, 5, 6, 7, 8] },
    ...extra,
  });

  it('parked on an old nurture wait → continues the same loop at 11 AM and still ends closed-lost', async () => {
    clock = ist('2026-11-10 07:30');
    tables.journey_enrollments.push({
      id: 'old-1', journey_id: 'j1', account_id: 'acct', contact_id: 'c1', status: 'waiting', wait_kind: 'reply',
      current_node_id: 'd_wait', steps_taken: 40, entered_at: ist('2026-11-01 10:00').toISOString(),
      // Old run: 3 Stage D messages sent at 7 AM, next due Wed 7 AM.
      next_run_at: realignedNurtureTime(ist('2026-11-11 07:00').toISOString()),
      context: oldContext({ loops: { loop_d: { items: [1, 2, 3, 4, 5, 6, 7, 8], index: 3 } }, loop_stack: ['loop_d'] }),
    });
    expect(label(new Date(String(tables.journey_enrollments[0].next_run_at)))).toBe('Wed 11 11:00');
    await runUntil('2026-11-30 00:00');
    expect(log()).toEqual(['Wed 11', 'Fri 13', 'Sun 15', 'Tue 17', 'Thu 19'].map((d) => `${d} 11:00 sg_nurture_payment`));
    expect(hasTag('closed_lost')).toBe(true);
    expect(run().status).toBe('completed');
  });

  const parkOld = (node: string, linkAt: string, nextRunAt: string) => {
    tables.conversations[0].last_customer_message_at = ist(linkAt).toISOString();
    tables.journey_enrollments.push({
      id: 'old-2', journey_id: 'j1', account_id: 'acct', contact_id: 'c1', status: 'waiting', wait_kind: 'reply',
      current_node_id: node, steps_taken: 20, entered_at: ist('2026-11-01 10:00').toISOString(),
      next_run_at: ist(nextRunAt).toISOString(),
      context: oldContext(),
    });
  };

  it('parked waiting for payment nudge 1 (no plan stored) → plans its nudges in daytime', async () => {
    clock = ist('2026-11-10 12:00');
    parkOld('reply_pay', '2026-11-10 10:00', '2026-11-10 16:00'); // link 10:00, old nudge 1 at 16:00
    await runUntil('2026-11-12 00:00');
    expect(log()).toEqual([
      'Tue 10 16:00 text:Hi Asha, just checking in 😊 Your spot in Revibe is still open.',
      'Wed 11 09:00 text:Hi Asha, your payment link is still active:', // not 4 AM
      'Wed 11 11:00 sg_nurture_payment',
    ]);
    expect(run().status).toBe('waiting');
  });

  it('parked for nudge 1 due at night → held to 9 AM, nudge 2 at 4 PM (window open until 10 PM)', async () => {
    clock = ist('2026-11-10 23:00');
    parkOld('reply_pay', '2026-11-10 22:00', '2026-11-11 04:00'); // link 22:00, old nudge 1 at 04:00
    await runUntil('2026-11-12 23:00');
    expect(log()).toEqual([
      'Wed 11 09:00 text:Hi Asha, just checking in 😊 Your spot in Revibe is still open.',
      'Wed 11 16:00 text:Hi Asha, your payment link is still active:',
      'Thu 12 11:00 sg_nurture_payment',
    ]);
  });

  it('parked for nudge 2 at night → --rebuild moves it to 9 AM, still inside the window', async () => {
    clock = ist('2026-11-10 17:00');
    parkOld('reply_pay2', '2026-11-10 10:00', '2026-11-11 04:00');
    const row = tables.journey_enrollments[0];
    row.next_run_at = realignedNudgeTime(String(row.next_run_at));
    await runUntil('2026-11-12 12:00');
    expect(log()).toEqual([
      'Wed 11 09:00 text:Hi Asha, your payment link is still active:',
      'Thu 12 11:00 sg_nurture_payment',
    ]);
  });

  it('realignedNudgeTime keeps daytime and moves night to 9 AM', () => {
    const at = (s: string) => {
      const r = realignedNudgeTime(ist(s).toISOString());
      return r && label(new Date(r));
    };
    expect(at('2026-11-11 04:00')).toBe('Wed 11 09:00');
    expect(at('2026-11-11 22:30')).toBe('Thu 12 09:00');
    expect(at('2026-11-11 14:00')).toBeNull();
  });

  it('realignedNurtureTime moves an old wait to the nearest 11 AM IST', () => {
    const at = (s: string) => label(new Date(realignedNurtureTime(ist(s).toISOString())!));
    expect(at('2026-11-11 07:00')).toBe('Wed 11 11:00');
    expect(at('2026-11-11 22:00')).toBe('Wed 11 11:00');
    expect(at('2026-11-11 23:30')).toBe('Thu 12 11:00');
    expect(at('2026-11-11 11:00')).toBe('Wed 11 11:00');
    expect(realignedNurtureTime('nonsense')).toBeNull();
  });
});

// ============================================================
// Registering again
// ============================================================
describe('registering again', () => {
  const again = (registrationId: string, when: string) =>
    restartJourneysOnReregistration(db(), { accountId: 'acct', contactId: 'c1', registrationId, registeredAt: ist(when).toISOString() }, deps);

  it('a lead who went lost registers again → fresh run, Msg 1 for the new webinar date', async () => {
    await register('2026-11-02 10:00');
    await runUntil('2026-11-25 00:00');
    expect(run().status).toBe('completed');
    clock = ist('2026-11-26 09:30');
    expect(await again('reg-2', '2026-11-26 09:29')).toBe(1);
    expect(log().at(-1)).toBe('Thu 26 09:30 sg_webinar_confirmation');
    expect(sent.at(-1)!.params?.slice(1, 3)).toEqual(['Thu, 26 Nov 2026', '8:00 PM IST']);
    expect(run()).toMatchObject({ status: 'waiting', current_node_id: 'wait_msg2' });
    // Re-read by the next sync (it looks back 60 minutes) → not restarted again.
    clock = ist('2026-11-26 09:31');
    expect(await again('reg-2', '2026-11-26 09:29')).toBe(0);
    expect(tables.journey_enrollments).toHaveLength(2);
  });

  it('registers again mid-journey → old run ended, new one started', async () => {
    await register('2026-11-02 10:00');
    await runUntil('2026-11-07 12:00'); // in Stage A
    expect(await again('reg-2', '2026-11-07 11:59')).toBe(1);
    const [old, fresh] = tables.journey_enrollments;
    expect(old).toMatchObject({ status: 'exited', last_error: 'Registered again — restarted' });
    expect(fresh).toMatchObject({ status: 'waiting' });
    expect(log().at(-1)).toBe('Sat 07 12:00 sg_webinar_confirmation');
    expect(sent.at(-1)!.params?.slice(1, 3)).toEqual(['Sun, 8 Nov 2026', '3:00 PM IST']); // Sat after 10 AM → Sun 3 PM
  });

  it('the registration that started the run is never treated as a new one', async () => {
    await register('2026-11-02 10:00');
    clock = ist('2026-11-02 10:30');
    expect(await again('reg-2026-11-02 10:00', '2026-11-02 10:00')).toBe(0);
    // An older registration (before this run) is ignored too.
    expect(await again('reg-older', '2026-11-02 09:00')).toBe(0);
    expect(tables.journey_enrollments).toHaveLength(1);
  });

  it('paid / closed / opted-out leads are not restarted', async () => {
    for (const tag of [TAG_IDS.paid, TAG_IDS.manually_closed, 'tag-unsub']) {
      tables.journey_enrollments = [];
      tables.contact_tags = [];
      sent = [];
      await register('2026-11-02 10:00');
      addTag('c1', tag);
      clock = ist('2026-11-20 10:00');
      expect(await again(`reg-${tag}`, '2026-11-20 09:59'), tag).toBe(0);
      expect(sent).toHaveLength(1);
    }
  });

  it('an existing contact who never ran the journey (e.g. messaged on WhatsApp first) gets it on registering', async () => {
    clock = ist('2026-11-03 09:00');
    expect(await again('reg-x', '2026-11-03 08:59')).toBe(1);
    expect(log()).toEqual(['Tue 03 09:00 sg_webinar_confirmation']);
  });
});
