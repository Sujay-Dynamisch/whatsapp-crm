// Builds the "Webinar Funnel — Swapnil Gautam" journey in Swapnil Gautam's
// account ONLY, following "Swapnil Gautam_Lead Lifecycle Flow.pdf" and the
// templates in SG_WhatsApp_Templates.pdf.
//
//   npx jiti scripts/swapnil/seed-journey.ts               # dry run: validate + print
//   npx jiti scripts/swapnil/seed-journey.ts --insert      # create tags + insert as draft
//   npx jiti scripts/swapnil/seed-journey.ts --rebuild     # replace the existing journey's graph
//                                                          #   (keeps the values in its "Settings" step)
//   npx jiti scripts/swapnil/seed-journey.ts --update-code # refresh only its code steps
import { ACCOUNT_ID, OWNER_USER_ID, connect } from './common';
import { validateGraph, type JourneyGraph, type JourneyNode, type JourneyNodeType, type NodeConfigs } from '../../src/lib/journeys/graph';
import { triggerColumns } from '../../src/lib/journeys/api';

const JOURNEY_NAME = 'Webinar Funnel — Swapnil Gautam';
const TAGS = ['webinar_registered', 'payment_link_sent', 'callback_requested', 'paid', 'manually_closed', 'closed_lost'] as const;

// Webinar slot from the contact's IST "added" time (contacts.created_at_ist,
// migration 055), per the lifecycle flow's cutoff rules:
//   Weekday (Mon–Fri): before 2:00 PM → today's 8:00 PM webinar, else next day's.
//   Weekend (Sat–Sun): before 10:00 AM → today's 3:00 PM webinar, else next day's.
//   Msg 2 at 2 PM (weekday) / 11 AM (weekend); Msg 3 at 7 PM / 2 PM;
//   check-in at 7 AM the day after the webinar.
// The "next day" uses its own weekday/weekend timings. All times are IST
// wall clock; outputs carry "+05:30" so waits resume at the right moment.
// `fromNow` = schedule from the current IST time (re-invite / nurture).
const scheduleCode = (fromNow: boolean) => `const H = 3600e3, DAY = 864e5;
const nowIst = new Date(Date.now() + 5.5 * H).toISOString().slice(0, 19);
const added = ${fromNow ? 'nowIst' : "vars.reschedule === 'yes' ? nowIst : String(contact.created_at_ist || nowIst).slice(0, 19)"};
const base = Date.parse(added.replace(' ', 'T') + 'Z'); // IST clock as plain ms
let day = Math.floor(base / DAY) * DAY;
let start = 0, msg2 = 0, msg3 = 0, weekend = false;
for (let i = 0; i < 8; i++) {
  const wd = new Date(day).getUTCDay();
  weekend = wd === 0 || wd === 6;
  start = day + (weekend ? 15 : 20) * H;
  msg2 = day + (weekend ? 11 : 14) * H;
  msg3 = day + (weekend ? 14 : 19) * H;
  if (i > 0 || base < day + (weekend ? 10 : 14) * H) break; // before today's cutoff, or the next day
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
  msg3_iso: ist(msg3),
  checkin_iso: ist(day + DAY + 7 * H),
};`;

const NAME = '{{ contact.name | default:"there" }}';
const S = (f: string) => `{{ nodes.schedule.${f} }}`;
const LINK = '{{ vars.webinar_link }}';

function build(tag: Record<(typeof TAGS)[number], string>): JourneyGraph {
  const nodes: JourneyNode[] = [];
  const add = <T extends JourneyNodeType>(id: string, type: T, label: string, config: NodeConfigs[T], next: Record<string, string> = {}) =>
    nodes.push({ id, type, label, config, next, position: { x: 0, y: 0 } } as JourneyNode);
  const tpl = (name: string, params: string[], retry_until?: string) => ({
    template_name: name,
    language: 'en_US',
    params,
    ...(retry_until ? { retry_until } : {}),
  });
  const lc = '{{ reply.text | lower | trim }}';

  // ---------- Registration → Msg 1 → Msg 2 / Msg 3 → 7 AM check-in ----------
  // Global overrides: STOP always ends the run (engine); paid / manually_closed
  // (kill switch) end it via exit tags.
  add('trigger', 'trigger', 'Contact added (API)', { trigger_type: 'contact_created', exit_tag_ids: [tag.paid, tag.manually_closed] }, { next: 'settings' });
  add('settings', 'set_variable', 'Settings (edit me)', {
    assignments: [
      { key: 'webinar_link', value: 'https://PASTE-WEBINAR-LINK' },
      { key: 'payment_link', value: 'https://PASTE-PAYMENT-LINK' },
      { key: 'testimonials_text', value: 'PASTE 2–3 TESTIMONIALS HERE' },
      { key: 'faq_text', value: 'PASTE FAQ ANSWERS HERE' },
    ],
  }, { next: 'nurture_days' });
  add('nurture_days', 'code', 'Nurture days (every 2nd day × 8)', { code: 'return [1, 2, 3, 4, 5, 6, 7, 8];' }, { success: 'schedule' });
  add('schedule', 'code', 'Webinar schedule (IST)', { code: scheduleCode(false) }, { success: 'is_reinvite' });
  add('is_reinvite', 'condition', 'Re-invite?', { kind: 'expression', left: '{{ vars.reschedule }}', op: 'equals', right: 'yes' }, { yes: 't4_reinvite', no: 't1_confirm' });
  add('t1_confirm', 'send_template', 'Msg 1 Confirmation + webinar link',
    tpl('sg_webinar_confirmation', [NAME, S('date_text'), S('time_text'), LINK], S('start_iso')), { next: 'tag_registered' });
  add('tag_registered', 'add_tag', 'Tag: webinar_registered', { tag_id: tag.webinar_registered }, { next: 'msg2_due' });
  add('t4_reinvite', 'send_template', 'Send next webinar link',
    tpl('sg_webinar_reinvite', [NAME, S('date_text'), S('time_text'), LINK], S('start_iso')), { next: 'msg2_due' });
  add('msg2_due', 'condition', 'Msg 2 still ahead?', { kind: 'expression', left: S('msg2_due'), op: 'equals', right: 'yes' }, { yes: 'wait_msg2', no: 'wait_msg3' });
  add('wait_msg2', 'wait', 'Wait until Msg 2 (2 PM / 11 AM)', { amount: 1, unit: 'hours', until: S('msg2_iso') }, { next: 't2_msg2' });
  add('t2_msg2', 'send_template', 'Msg 2 Reminder',
    tpl('sg_webinar_reminder', [NAME, S('phrase'), S('date_text'), S('time_text'), LINK], S('msg3_iso')), { next: 'wait_msg3' });
  add('wait_msg3', 'wait', 'Wait until Msg 3 (7 PM / 2 PM)', { amount: 1, unit: 'hours', until: S('msg3_iso') }, { next: 't2_msg3' });
  add('t2_msg3', 'send_template', 'Msg 3 Starting in 1 hour',
    tpl('sg_webinar_reminder', [NAME, 'starting in 1 hour', S('date_text'), S('time_text'), LINK], S('start_iso')), { next: 'wait_checkin' });
  add('wait_checkin', 'wait', 'Wait until 7 AM next day', { amount: 12, unit: 'hours', until: S('checkin_iso') }, { next: 't3_checkin' });
  add('t3_checkin', 'send_template', 'Post-webinar check-in (menu)', tpl('sg_post_webinar_checkin', [NAME]), { next: 'reply_menu' });
  add('reply_menu', 'wait_for_reply', 'Wait for menu reply', { amount: 24, unit: 'hours' }, { replied: 'menu', timeout: 'auto_reinvited' });

  // No response → send the next webinar link once and re-enter the
  // reminder loop; still nothing after that → nurture (Stage A / B).
  add('auto_reinvited', 'condition', 'Already re-invited?', { kind: 'expression', left: '{{ vars.auto_reinvite }}', op: 'equals', right: 'yes' }, { yes: 'ever_replied', no: 'set_auto_reinvite' });
  add('set_auto_reinvite', 'set_variable', 'Re-invite (no response)', {
    assignments: [{ key: 'auto_reinvite', value: 'yes' }, { key: 'reschedule', value: 'yes' }],
  }, { next: 'schedule' });
  add('ever_replied', 'condition', 'Replied since registering?', { kind: 'replied' }, { yes: 'loop_b', no: 'loop_a' });

  // ---------- Conversion menu (typed 1–4 or the template's buttons) ----------
  add('menu', 'switch', 'Menu choice', {
    value: lc,
    cases: [
      { op: 'starts_with', value: '1', label: '1 Join' },
      { op: 'contains', value: 'join', label: 'Ready to Join' },
      { op: 'starts_with', value: '2', label: '2 Success stories' },
      { op: 'contains', value: 'testimon', label: 'Testimonials' },
      { op: 'starts_with', value: '3', label: '3 Next session' },
      { op: 'contains', value: 'attend', label: "Couldn't attend" },
      { op: 'starts_with', value: '4', label: '4 Callback' },
      { op: 'contains', value: 'call', label: 'Request a callback' },
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

  // Payment link → 1–2 nudges inside the 24-hour window → Stage D nurture.
  // Payment received = tag "paid" → the run stops (WON).
  add('pay_link', 'send_text', 'Send payment link', {
    text: `Great decision, ${NAME}! 🎉\n\nHere's your link to join Revibe:\n{{ vars.payment_link }}\n\nReply here if you have any questions.\n\n— Swapnil Gautam`,
  }, { next: 'tag_paylink' });
  add('tag_paylink', 'add_tag', 'Tag: payment_link_sent', { tag_id: tag.payment_link_sent }, { next: 'reply_pay' });
  add('reply_pay', 'wait_for_reply', 'Wait 6h after payment link', { amount: 6, unit: 'hours' }, { replied: 'pay_reply', timeout: 'pay_nudge1' });
  add('pay_nudge1', 'send_text', 'Payment nudge 1', {
    text: `Hi ${NAME}, just checking in 😊 Your spot in Revibe is still open.\n\nComplete your enrollment here:\n{{ vars.payment_link }}\n\nAny questions? Just reply here.\n\n— Swapnil Gautam`,
  }, { next: 'reply_pay2' });
  add('reply_pay2', 'wait_for_reply', 'Wait 12h after nudge 1', { amount: 12, unit: 'hours' }, { replied: 'pay_reply', timeout: 'pay_nudge2' });
  add('pay_nudge2', 'send_text', 'Payment nudge 2', {
    text: `Hi ${NAME}, your payment link is still active:\n{{ vars.payment_link }}\n\nIf something is holding you back — instalments, what's included, start date — reply and I'll sort it personally.\n\n— Swapnil Gautam`,
  }, { next: 'reply_pay3' });
  add('reply_pay3', 'wait_for_reply', 'Wait 5h after nudge 2', { amount: 5, unit: 'hours' }, { replied: 'pay_reply', timeout: 'loop_d' });
  add('pay_reply', 'switch', 'Payment reply', {
    value: lc,
    cases: [
      { op: 'contains', value: 'not proceed', label: 'Not proceeding' },
      { op: 'contains', value: 'complete payment', label: 'Complete payment' },
      { op: 'contains', value: 'join', label: 'Join' },
    ],
  }, { case_0: 'tag_closed', case_1: 'pay_link', case_2: 'pay_link', default: 'faq' });
  add('faq', 'send_text', 'FAQ + handoff', { text: '{{ vars.faq_text }}\n\nMy team will also reach out to you personally.' }, { next: 'tag_callback' });
  add('tag_closed', 'add_tag', 'Tag: manually_closed (LOST)', { tag_id: tag.manually_closed }, { next: 'closed_msg' });
  add('closed_msg', 'send_text', 'Confirm stop', { text: `Understood, ${NAME}. I won't send further messages. Wishing you the best!\n\n— Swapnil Gautam` }, { next: 'end' });

  // Testimonials (+ disclaimer) → re-prompt: payment or callback only
  // (capped, no more testimonials) → Stage C nurture.
  add('testimonials', 'send_text', 'Send testimonials', {
    text: '{{ vars.testimonials_text }}\n\n_Results may vary from person to person._',
  }, { next: 'reply_testi' });
  add('reply_testi', 'wait_for_reply', 'Wait 24h after testimonials', { amount: 24, unit: 'hours' }, { replied: 't5_menu', timeout: 't5_reprompt' });
  add('t5_reprompt', 'send_template', 'Re-prompt: payment or callback', tpl('sg_testimonial_reprompt', [NAME]), { next: 'reply_t5' });
  add('reply_t5', 'wait_for_reply', 'Wait 48h after re-prompt', { amount: 48, unit: 'hours' }, { replied: 't5_menu', timeout: 'loop_c' });
  add('t5_menu', 'switch', 'Payment or callback', {
    value: lc,
    cases: [
      { op: 'starts_with', value: '1', label: '1 Join' },
      { op: 'contains', value: 'join', label: 'Ready to Join' },
      { op: 'starts_with', value: '2', label: '2 Callback' },
      { op: 'contains', value: 'call', label: 'Request Callback' },
      { op: 'contains', value: 'talk', label: 'Talk to team' },
    ],
  }, { case_0: 'pay_link', case_1: 'pay_link', case_2: 'tag_callback', case_3: 'tag_callback', case_4: 'tag_callback', default: 't5_retry' });
  add('t5_retry', 'send_text', 'Ask for 1–2', { text: 'Please reply 1 to join Revibe or 2 to request a callback from my team. 🙏' }, { next: 'reply_t5' });

  // Attend again → next webinar link → reminder loop.
  add('set_reschedule', 'set_variable', 'Mark re-invite', { assignments: [{ key: 'reschedule', value: 'yes' }] }, { next: 'schedule' });

  // Request callback → human handoff (automation stops; sales marks paid / lost).
  add('tag_callback', 'add_tag', 'Tag: callback_requested', { tag_id: tag.callback_requested }, { next: 'assign_owner' });
  add('assign_owner', 'conversation', 'Human handoff (assign Swapnil)', { action: 'assign', user_id: OWNER_USER_ID }, { next: 'callback_msg' });
  add('callback_msg', 'send_text', 'Confirm callback', { text: `Thank you, ${NAME}! 🙏 My team will call you shortly.` }, { next: 'end' });

  // ---------- 15-day alternate-day nurture → CLOSED LOST ----------
  const stage = (key: string, label: string, template: string, params: string[], onReply: string, pre?: string) => {
    add(`loop_${key}`, 'loop', `Stage ${key.toUpperCase()} nurture (${label})`, { items: '{{ nodes.nurture_days }}', max: 8 }, { each: pre ?? `${key}_send`, done: 'tag_lost' });
    if (pre) add(pre, 'code', 'Next webinar (IST)', { code: scheduleCode(true) }, { success: `${key}_send` });
    add(`${key}_send`, 'send_template', `${template}`, tpl(template, params), { next: `${key}_wait` });
    add(`${key}_wait`, 'wait_for_reply', 'Wait 2 days', { amount: 2, unit: 'days' }, { replied: onReply, timeout: `loop_${key}` });
  };
  stage('a', 'pre-webinar dropout', 'sg_nurture_prewebinar',
    [NAME, '{{ nodes.a_next.date_text }}', '{{ nodes.a_next.time_text }}', LINK], 'menu', 'a_next');
  stage('b', 'post check-in cold', 'sg_nurture_postwebinar', [NAME], 'menu');
  stage('c', 'conversion menu cold', 'sg_nurture_coldlead', [NAME], 'menu');
  stage('d', 'payment abandoned', 'sg_nurture_payment', [NAME, '{{ vars.payment_link }}'], 'pay_reply');
  add('tag_lost', 'add_tag', 'Tag: closed_lost (15 days, no response)', { tag_id: tag.closed_lost }, { next: 'end' });

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
  const insert = process.argv.includes('--insert') || process.argv.includes('--rebuild');
  const db = await connect();

  // Tags: reuse existing by name, create the rest (write modes only).
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
  if (dupe && process.argv.includes('--rebuild')) {
    // Keep what the team filled in on the "Settings" step.
    const old = (dupe.graph as JourneyGraph).nodes.find((n) => n.id === 'settings');
    const settings = graph.nodes.find((n) => n.id === 'settings');
    if (old && settings) settings.config = old.config;
    const { error } = await db
      .from('journeys')
      .update({ graph, ...triggerColumns(graph), updated_at: new Date().toISOString() })
      .eq('id', dupe.id)
      .eq('account_id', ACCOUNT_ID);
    if (error) throw error;
    console.log(`Rebuilt journey ${dupe.id} (${graph.nodes.length} steps; Settings kept).`);
    return;
  }
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
    console.log(`Journey "${JOURNEY_NAME}" already exists (${dupe.id}); use --rebuild to replace its graph.`);
    return;
  }
  if (!process.argv.includes('--insert')) {
    console.log('Dry run only. Re-run with --insert to create tags + the draft journey.');
    return;
  }

  const { data, error } = await db
    .from('journeys')
    .insert({
      account_id: ACCOUNT_ID,
      name: JOURNEY_NAME,
      description: 'Webinar registration → reminders → 7 AM check-in → conversion menu → 15-day nurture (Lead Lifecycle Flow).',
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
