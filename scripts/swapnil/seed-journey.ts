// Builds the "Webinar Funnel — Swapnil Gautam" journey (SG_WhatsApp_Templates.pdf)
// in Swapnil Gautam's account ONLY. Inserted as a draft; activate it from the
// journey editor once the T5–T9 templates are approved and the "Settings"
// step (links, testimonials, FAQ) is filled in.
//
//   npx jiti scripts/swapnil/seed-journey.ts            # dry run: validate + print
//   npx jiti scripts/swapnil/seed-journey.ts --insert   # create tags + insert journey
//   npx jiti scripts/swapnil/seed-journey.ts --update-code   # refresh code steps of the existing journey
import { ACCOUNT_ID, OWNER_USER_ID, connect } from './common';
import { validateGraph, type JourneyGraph, type JourneyNode, type JourneyNodeType, type NodeConfigs } from '../../src/lib/journeys/graph';
import { triggerColumns } from '../../src/lib/journeys/api';

const JOURNEY_NAME = 'Webinar Funnel — Swapnil Gautam';
const TAGS = ['webinar_registered', 'payment_link_sent', 'callback_requested', 'paid', 'manually_closed'] as const;

// Webinar slot from the contact's IST "added" time (contacts.created_at_ist,
// migration 055). Weekday 8:00 PM, weekend 3:00 PM; the afternoon reminder
// (Msg 2) at 2 PM / 11 AM. A lead added later than one hour before the
// session is booked into the next day's session. All times are IST wall
// clock; outputs carry "+05:30" so the wait steps resume at the right moment.
// `fromNow` = schedule from the current IST time (re-invite / nurture).
const scheduleCode = (fromNow: boolean) => `const H = 3600e3, DAY = 864e5;
const nowIst = new Date(Date.now() + 5.5 * H).toISOString().slice(0, 19);
const added = ${fromNow ? 'nowIst' : "vars.reschedule === 'yes' ? nowIst : String(contact.created_at_ist || nowIst).slice(0, 19)"};
const base = Date.parse(added.replace(' ', 'T') + 'Z'); // IST clock as plain ms
let day = Math.floor(base / DAY) * DAY;
let start = 0, msg2 = 0, weekend = false;
for (let i = 0; i < 8; i++) {
  const wd = new Date(day).getUTCDay();
  weekend = wd === 0 || wd === 6;
  start = day + (weekend ? 15 : 20) * H;
  msg2 = day + (weekend ? 11 : 14) * H;
  if (base <= start - H) break;
  day += DAY;
}
const ist = (ms) => new Date(ms).toISOString().slice(0, 19) + '+05:30';
const d = new Date(start);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
return {
  added_ist: added,
  date_text: DAYS[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(),
  time_text: weekend ? '3:00 PM IST' : '8:00 PM IST',
  phrase: weekend ? 'this afternoon at 3:00 PM' : 'coming up tonight at 8:00 PM',
  start_iso: ist(start),
  msg2_due: base < msg2 ? 'yes' : 'no',
  msg2_iso: ist(msg2),
  msg3_iso: ist(start - H),
  checkin_iso: ist(day + DAY + 7 * H),
};`;

const NAME = '{{ contact.name | default:"there" }}';
const S = (f: string) => `{{ nodes.schedule.${f} }}`;
const LINK = '{{ vars.webinar_link }}';

function build(tag: Record<(typeof TAGS)[number], string>): JourneyGraph {
  const nodes: JourneyNode[] = [];
  const add = <T extends JourneyNodeType>(id: string, type: T, label: string, config: NodeConfigs[T], next: Record<string, string> = {}) =>
    nodes.push({ id, type, label, config, next, position: { x: 0, y: 0 } } as JourneyNode);
  const tpl = (name: string, params: string[]) => ({ template_name: name, language: 'en_US', params });
  const lc = '{{ reply.text | lower | trim }}';

  // ---------- Registration → reminders → 7 AM check-in ----------
  add('trigger', 'trigger', 'Contact added (API)', { trigger_type: 'contact_created' }, { next: 'settings' });
  add('settings', 'set_variable', 'Settings (edit me)', {
    assignments: [
      { key: 'webinar_link', value: 'https://PASTE-WEBINAR-LINK' },
      { key: 'payment_link', value: 'https://PASTE-PAYMENT-LINK' },
      { key: 'testimonials_text', value: 'PASTE TESTIMONIALS / SUCCESS STORIES HERE' },
      { key: 'faq_text', value: 'PASTE FAQ ANSWERS HERE' },
    ],
  }, { next: 'nurture_days' });
  add('nurture_days', 'code', 'Nurture days (every 2nd day × 8)', { code: 'return [1, 2, 3, 4, 5, 6, 7, 8];' }, { success: 'schedule' });
  add('schedule', 'code', 'Webinar schedule (IST)', { code: scheduleCode(false) }, { success: 'is_reinvite' });
  add('is_reinvite', 'condition', 'Re-invite?', { kind: 'expression', left: '{{ vars.reschedule }}', op: 'equals', right: 'yes' }, { yes: 't4_reinvite', no: 't1_confirm' });
  add('t1_confirm', 'send_template', 'T1 Registration confirmation',
    tpl('registration_confirmation', [NAME, S('date_text'), S('time_text'), LINK]), { next: 'tag_registered' });
  add('tag_registered', 'add_tag', 'Tag: webinar_registered', { tag_id: tag.webinar_registered }, { next: 'msg2_due' });
  add('t4_reinvite', 'send_template', 'T4 Next webinar date',
    tpl('triggered_when_lead_selects_option_3', [NAME, S('date_text'), S('time_text'), LINK]), { next: 'msg2_due' });
  add('msg2_due', 'condition', 'Afternoon reminder still ahead?', { kind: 'expression', left: S('msg2_due'), op: 'equals', right: 'yes' }, { yes: 'wait_msg2', no: 'wait_msg3' });
  add('wait_msg2', 'wait', 'Wait until afternoon reminder', { amount: 1, unit: 'hours', until: S('msg2_iso') }, { next: 't2_msg2' });
  add('t2_msg2', 'send_template', 'Msg 2 Afternoon reminder',
    tpl('reminder_for_webinar', [NAME, S('phrase'), S('date_text'), S('time_text'), LINK]), { next: 'wait_msg3' });
  add('wait_msg3', 'wait', 'Wait until 1 hr before', { amount: 1, unit: 'hours', until: S('msg3_iso') }, { next: 't2_msg3' });
  add('t2_msg3', 'send_template', 'Msg 3 Starting in 1 hour',
    tpl('reminder_for_webinar', [NAME, 'starting in 1 hour', S('date_text'), S('time_text'), LINK]), { next: 'wait_checkin' });
  add('wait_checkin', 'wait', 'Wait until 7 AM next day', { amount: 12, unit: 'hours', until: S('checkin_iso') }, { next: 't3_checkin' });
  add('t3_checkin', 'send_template', 'T3 Post-webinar check-in', tpl('trigger_sent_at_7', [NAME]), { next: 'reply_menu' });
  add('reply_menu', 'wait_for_reply', 'Wait for menu reply', { amount: 24, unit: 'hours' }, { replied: 'menu', timeout: 'ever_replied' });

  // ---------- 4-option conversion menu (typed 1–4 or quick-reply buttons) ----------
  add('menu', 'switch', 'Menu choice', {
    value: lc,
    cases: [
      { op: 'starts_with', value: '1', label: '1 Join' },
      { op: 'contains', value: 'join', label: 'Join' },
      { op: 'starts_with', value: '2', label: '2 Stories' },
      { op: 'contains', value: 'testimon', label: 'Testimonials' },
      { op: 'starts_with', value: '3', label: '3 Next session' },
      { op: 'contains', value: 'attend', label: "Couldn't attend" },
      { op: 'starts_with', value: '4', label: '4 Callback' },
      { op: 'contains', value: 'call', label: 'Callback' },
      { op: 'contains', value: 'question', label: 'Questions' },
    ],
  }, {
    case_0: 'pay_link', case_1: 'pay_link',
    case_2: 'testimonials', case_3: 'testimonials',
    case_4: 'set_reschedule', case_5: 'set_reschedule',
    case_6: 'tag_callback', case_7: 'tag_callback', case_8: 'tag_callback',
    default: 'menu_retry',
  });
  add('menu_retry', 'send_text', 'Ask for 1–4', { text: 'Please reply with 1, 2, 3 or 4 so I can help you with your next step. 🙏' }, { next: 'reply_menu' });

  // Option 1 — payment link → Stage D nurture if no payment / reply
  add('pay_link', 'send_text', 'Send payment link', {
    text: `Great decision, ${NAME}! 🎉\n\nHere's your link to join Revibe:\n{{ vars.payment_link }}\n\nReply here if you have any questions.\n\n— Swapnil Gautam`,
  }, { next: 'tag_paylink' });
  add('tag_paylink', 'add_tag', 'Tag: payment_link_sent', { tag_id: tag.payment_link_sent }, { next: 'reply_pay' });
  add('reply_pay', 'wait_for_reply', 'Wait 24h after payment link', { amount: 24, unit: 'hours' }, { replied: 'pay_reply', timeout: 'loop_d' });
  add('pay_reply', 'switch', 'Payment reply', {
    value: lc,
    cases: [
      { op: 'contains', value: 'not proceed', label: 'Not proceeding' },
      { op: 'contains', value: 'complete payment', label: 'Complete payment' },
      { op: 'contains', value: 'join', label: 'Join' },
    ],
  }, { case_0: 'tag_closed', case_1: 'pay_link', case_2: 'pay_link', default: 'faq' });
  add('faq', 'send_text', 'FAQ + handoff', { text: '{{ vars.faq_text }}\n\nMy team will also reach out to you personally.' }, { next: 'tag_callback' });
  add('tag_closed', 'add_tag', 'Tag: manually_closed', { tag_id: tag.manually_closed }, { next: 'closed_msg' });
  add('closed_msg', 'send_text', 'Confirm stop', { text: `Understood, ${NAME}. I won't send further messages. Wishing you the best!\n\n— Swapnil Gautam` }, { next: 'end' });

  // Option 2 — testimonials → T5 reprompt (once) → Stage C nurture
  add('testimonials', 'send_text', 'Send testimonials', { text: '{{ vars.testimonials_text }}' }, { next: 'reply_testi' });
  add('reply_testi', 'wait_for_reply', 'Wait 24h after testimonials', { amount: 24, unit: 'hours' }, { replied: 'menu', timeout: 't5_reprompt' });
  add('t5_reprompt', 'send_template', 'T5 Testimonial reprompt', tpl('sg_testimonial_reprompt', [NAME]), { next: 'reply_t5' });
  add('reply_t5', 'wait_for_reply', 'Wait 48h after reprompt', { amount: 48, unit: 'hours' }, { replied: 'menu', timeout: 'loop_c' });

  // Option 3 — attend again → back into the Msg 2 / Msg 3 loop
  add('set_reschedule', 'set_variable', 'Mark re-invite', { assignments: [{ key: 'reschedule', value: 'yes' }] }, { next: 'schedule' });

  // Option 4 — callback → human handoff
  add('tag_callback', 'add_tag', 'Tag: callback_requested', { tag_id: tag.callback_requested }, { next: 'assign_owner' });
  add('assign_owner', 'conversation', 'Assign to Swapnil', { action: 'assign', user_id: OWNER_USER_ID }, { next: 'callback_msg' });
  add('callback_msg', 'send_text', 'Confirm callback', { text: `Thank you, ${NAME}! 🙏 My team will call you shortly.` }, { next: 'end' });

  // No reply to check-in: Stage A (never replied) / Stage B (replied before)
  add('ever_replied', 'condition', 'Replied since registering?', { kind: 'replied' }, { yes: 'loop_b', no: 'loop_a' });

  // ---------- Nurture stages: every 2nd day, up to 15 days ----------
  const stage = (key: string, label: string, template: string, params: string[], onReply: string, pre?: string) => {
    add(`loop_${key}`, 'loop', `Stage ${key.toUpperCase()} nurture (${label})`, { items: '{{ nodes.nurture_days }}', max: 8 }, { each: `${key}_closed`, done: 'end' });
    add(`${key}_closed`, 'condition', 'Closed?', { kind: 'has_tag', tag_id: tag.manually_closed }, { yes: 'end', no: `${key}_paid` });
    add(`${key}_paid`, 'condition', 'Paid?', { kind: 'has_tag', tag_id: tag.paid }, { yes: 'end', no: pre ?? `${key}_send` });
    if (pre) add(pre, 'code', 'Next webinar (IST)', { code: scheduleCode(true) }, { success: `${key}_send` });
    add(`${key}_send`, 'send_template', `T${{ a: 6, b: 7, c: 8, d: 9 }[key]} ${label}`, tpl(template, params), { next: `${key}_wait` });
    add(`${key}_wait`, 'wait_for_reply', 'Wait 2 days', { amount: 2, unit: 'days' }, { replied: onReply, timeout: `loop_${key}` });
  };
  stage('a', 'pre-webinar dropout', 'sg_nurture_prewebinar',
    [NAME, '{{ nodes.a_next.date_text }}', '{{ nodes.a_next.time_text }}', LINK], 'menu', 'a_next');
  stage('b', 'post check-in cold', 'sg_nurture_postwebinar', [NAME], 'menu');
  stage('c', 'conversion menu cold', 'sg_nurture_coldlead', [NAME], 'menu');
  stage('d', 'payment abandoned', 'sg_nurture_payment', [NAME, '{{ vars.payment_link }}'], 'pay_reply');

  add('end', 'end', 'End', {} as NodeConfigs['end']);

  // Simple top-down layout: depth from the trigger → y, order in row → x.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>([['trigger', 0]]);
  const queue = ['trigger'];
  while (queue.length) {
    const id = queue.shift()!;
    for (const to of Object.values(byId.get(id)!.next)) {
      if (to && !depth.has(to)) {
        depth.set(to, depth.get(id)! + 1);
        queue.push(to);
      }
    }
  }
  const rows = new Map<number, number>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const i = rows.get(d) ?? 0;
    rows.set(d, i + 1);
    n.position = { x: i * 300, y: d * 180 };
  }
  return { nodes };
}

async function main() {
  const insert = process.argv.includes('--insert');
  const db = await connect();

  // Tags: reuse existing by name, create the rest (insert mode only).
  const { data: existing } = await db.from('tags').select('id, name').eq('account_id', ACCOUNT_ID);
  const ids = Object.fromEntries((existing ?? []).map((t) => [t.name, t.id])) as Record<string, string>;
  for (const name of TAGS) {
    if (ids[name]) continue;
    if (!insert) {
      ids[name] = `<new:${name}>`;
      continue;
    }
    const { data, error } = await db.from('tags').insert({ account_id: ACCOUNT_ID, user_id: OWNER_USER_ID, name }).select('id').single();
    if (error) throw new Error(`Create tag ${name}: ${error.message}`);
    ids[name] = data.id;
  }

  const graph = build(ids as Record<(typeof TAGS)[number], string>);
  const issues = validateGraph(graph);
  console.log(`${graph.nodes.length} steps; validation: ${issues.length ? '' : 'OK'}`);
  for (const i of issues) console.log(`  - ${i.nodeId ?? 'graph'}: ${i.message}`);
  if (issues.length) process.exit(1);

  const { data: dupe } = await db.from('journeys').select('id, graph').eq('account_id', ACCOUNT_ID).eq('name', JOURNEY_NAME).maybeSingle();
  if (dupe && process.argv.includes('--update-code')) {
    // Refresh only the schedule code steps of the existing journey.
    const fresh = new Map(graph.nodes.filter((n) => n.type === 'code').map((n) => [n.id, n.config]));
    const nodes = (dupe.graph as JourneyGraph).nodes.map((n) => (n.type === 'code' && fresh.has(n.id) ? { ...n, config: fresh.get(n.id)! } : n));
    const { error } = await db.from('journeys').update({ graph: { nodes }, updated_at: new Date().toISOString() }).eq('id', dupe.id).eq('account_id', ACCOUNT_ID);
    if (error) throw error;
    console.log(`Updated code steps in journey ${dupe.id}.`);
    return;
  }
  if (dupe) {
    console.log(`Journey "${JOURNEY_NAME}" already exists (${dupe.id}); not inserting again.`);
    return;
  }
  if (!insert) {
    console.log('Dry run only. Re-run with --insert to create tags + the draft journey.');
    return;
  }

  const { data, error } = await db
    .from('journeys')
    .insert({
      account_id: ACCOUNT_ID,
      name: JOURNEY_NAME,
      description: 'Webinar registration → reminders → 7 AM check-in → conversion menu → 15-day nurture (SG_WhatsApp_Templates.pdf).',
      status: 'draft',
      ...triggerColumns(graph),
      graph,
      allow_reentry: false,
      created_by: OWNER_USER_ID,
    })
    .select('id')
    .single();
  if (error) throw new Error(`Insert journey: ${error.message}`);
  console.log(`Created draft journey ${data.id} in account ${ACCOUNT_ID}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
