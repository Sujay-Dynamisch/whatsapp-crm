// The "Webinar Funnel — Swapnil Gautam" journey graph, built from
// "Swapnil Gautam_Lead Lifecycle Flow.pdf" and SG_WhatsApp_Templates.pdf.
// Pure (no database): seed-journey.ts writes it, and
// src/lib/journeys/swapnil-journey.test.ts runs it end to end.
//
// Timing rules (all IST):
//   * Msg 1 goes out the moment the lead registers, any time of day.
//   * Webinar 8 PM weekdays / 3 PM weekends; cutoff 2 PM / 10 AM.
//     Msg 2 at 2 PM / 11 AM, Msg 3 at 7 PM / 2 PM, check-in 7 AM next day.
//   * Replies to the lead's own message go out at once.
//   * Payment nudges are free-form text, so they must land inside
//     WhatsApp's 24-hour window: +6h / +18h after the link, moved out of
//     night hours (9 PM–9 AM → 9 AM), and skipped when that would push
//     them past the window (a window_open check guards the send too).
//   * Nurture (Stages A–D): a template at 11:00 AM every 2nd day, 8 sends
//     (days 0–14), then CLOSED-LOST at 11:00 AM on day 15. Meta retries of
//     a failed nurture template stop at 9 PM that day.
//   * Stage choice when a lead goes cold after the check-in:
//       answered the menu (or a nurture) at some point   → C
//       replied at some point, but never to the menu      → B
//       never replied                                     → A
//     Payment link sent, no payment within 24h            → D
import type { JourneyGraph, JourneyNode, JourneyNodeType, NodeConfigs } from '../../src/lib/journeys/graph';

export const JOURNEY_NAME = 'Webinar Funnel — Swapnil Gautam';
export const TAGS = ['webinar_registered', 'payment_link_sent', 'callback_requested', 'paid', 'manually_closed', 'closed_lost'] as const;
export type TagIds = Record<(typeof TAGS)[number], string>;

/** Nurture sends go out at this IST hour. */
export const NURTURE_HOUR = 11;
/** "No answer" marks on a callback before the lead goes back to nurture. */
export const CALLBACK_NO_ANSWER_LIMIT = 2;
/** Payment nudges only between these IST hours. */
export const DAY_START_HOUR = 9;
export const DAY_END_HOUR = 21;
/** Ids of the nurture "wait" steps (in-flight runs parked there are realigned on rebuild). */
export const NURTURE_WAIT_IDS = ['a_wait', 'b_wait', 'c_wait', 'd_wait'];
/** The wait before payment nudge 2 (in-flight runs parked there at night are moved to 9 AM on rebuild). */
export const NUDGE2_WAIT_ID = 'reply_pay2';

// Every code step reads the engine's clock ($input.now), so a run that
// resumes late, or a test with a simulated clock, computes from the
// moment the step actually runs.
const CLOCK = `const H = 3600e3, DAY = 864e5, IST = 5.5 * H;
const NOW = Date.parse($input.now || '') || Date.now();`;

// Webinar slot from the contact's IST "added" time (contacts.created_at_ist,
// migration 055), per the lifecycle flow's cutoff rules:
//   Weekday (Mon–Fri): before 2:00 PM → today's 8:00 PM webinar, else next day's.
//   Weekend (Sat–Sun): before 10:00 AM → today's 3:00 PM webinar, else next day's.
//   Msg 2 at 2 PM (weekday) / 11 AM (weekend); Msg 3 at 7 PM / 2 PM;
//   check-in at 7 AM the day after the webinar.
// The "next day" uses its own weekday/weekend timings. Outputs carry
// "+05:30" so waits resume at the right moment.
// `fromNow` = schedule from the current IST time (re-invite / nurture).
// A lead who registered again is scheduled from now too.
export const scheduleCode = (fromNow: boolean) => `${CLOCK}
const nowIst = new Date(NOW + IST).toISOString().slice(0, 19);
const added = ${fromNow ? 'nowIst' : "vars.reschedule === 'yes' || (trigger && trigger.reregistered) ? nowIst : String(contact.created_at_ist || nowIst).slice(0, 19)"};
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

// When the next nurture step happens: the first send at the next 11 AM;
// after a send, the next 11 AM at least 36h later (= 2 days on), or
// after the last send, the next 11 AM at least 12h later (= day 15,
// CLOSED-LOST). Retries of a failed send stop at 9 PM that day.
export const nurtureSlotCode = (stage: string) => `${CLOCK}
const sent = Boolean(nodes['${stage}_send']);
const lp = nodes['loop_${stage}'];
const last = Boolean(lp && typeof lp.index === 'number' && typeof lp.total === 'number' && lp.index >= lp.total - 1);
const from = NOW + (!sent ? 0 : last ? 12 * H : 36 * H) + IST; // IST wall clock as plain ms
let at = Math.floor(from / DAY) * DAY + ${NURTURE_HOUR} * H;
if (at < from) at += DAY;
return {
  at: new Date(at - IST).toISOString(),
  retry_until: new Date(at - IST + ${DAY_END_HOUR - NURTURE_HOUR} * H).toISOString(),
  final: sent && last ? 'yes' : 'no',
};`;

// Payment nudge plan, from the moment the payment link went out (right
// after the lead's reply, so the 24-hour window ends ~24h from now).
// A run that was already waiting for nudge 1 before this version has
// no plan: it plans as if the link went out 6 hours ago.
export const paymentPlanCode = `${CLOCK}
const M = 60e3;
const BASE = vars.pay_late === 'yes' && !nodes.pay_plan ? NOW - 6 * H : NOW;
const daytime = (t) => {
  const ist = t + IST, d = Math.floor(ist / DAY) * DAY, h = (ist - d) / H;
  if (h < ${DAY_START_HOUR}) return d + ${DAY_START_HOUR} * H - IST;
  if (h >= ${DAY_END_HOUR}) return d + DAY + ${DAY_START_HOUR} * H - IST;
  return t;
};
const end = BASE + 24 * H, latest = end - 30 * M;
const n1 = daytime(BASE + 6 * H), n1ok = n1 <= latest;
const n2 = daytime(Math.max(BASE + 18 * H, (n1ok ? n1 : BASE) + 3 * H)), n2ok = n2 <= latest;
const iso = (t) => new Date(t).toISOString();
return {
  n1_ok: n1ok ? 'yes' : 'no',
  n1_iso: iso(n1),
  n2_ok: n2ok ? 'yes' : 'no',
  n2_iso: iso(n2),
  end_iso: iso(end),
  step1_iso: iso(n1ok ? n1 : n2ok ? n2 : end),
  step2_iso: iso(n2ok ? n2 : end),
};`;

export function buildJourney(tag: TagIds, ownerUserId: string): JourneyGraph {
  const nodes: JourneyNode[] = [];
  const add = <T extends JourneyNodeType>(id: string, type: T, label: string, config: NodeConfigs[T], next: Record<string, string> = {}) =>
    nodes.push({ id, type, label, config, next, position: { x: 0, y: 0 } } as JourneyNode);
  const tpl = (name: string, params: string[], retry_until?: string) => ({
    template_name: name,
    language: 'en_US',
    params,
    ...(retry_until ? { retry_until } : {}),
  });
  const NAME = '{{ contact.name | default:"there" }}';
  const S = (f: string) => `{{ nodes.schedule.${f} }}`;
  const LINK = '{{ vars.webinar_link }}';
  const lc = '{{ reply.text | lower | trim }}';
  const isYes = (left: string) => ({ kind: 'expression' as const, left, op: 'equals' as const, right: 'yes' });
  // Missing value (a run from before this version) counts as "go ahead".
  const notNo = (left: string) => ({ kind: 'expression' as const, left, op: 'not_equals' as const, right: 'no' });

  // ---------- Registration → Msg 1 → Msg 2 / Msg 3 → 7 AM check-in ----------
  // Global overrides: STOP always ends the run (engine); paid / manually_closed
  // (kill switch) end it via exit tags.
  add('trigger', 'trigger', 'Contact added (API)', {
    trigger_type: 'contact_created',
    contact_source: 'api',
    exit_tag_ids: [tag.paid, tag.manually_closed],
    // Callback follow-ups (Callbacks page): "No answer" → cb_missed; 2nd
    // "No answer", "Back to nurture" or 48h without action → Stage C.
    callback_missed_node: 'cb_missed',
    callback_return_node: 'c_slot',
    callback_no_answer_limit: CALLBACK_NO_ANSWER_LIMIT,
  }, { next: 'settings' });
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
  add('is_reinvite', 'condition', 'Re-invite?', isYes('{{ vars.reschedule }}'), { yes: 't4_reinvite', no: 't1_confirm' });
  add('t1_confirm', 'send_template', 'Msg 1 Confirmation + webinar link',
    tpl('sg_webinar_confirmation', [NAME, S('date_text'), S('time_text'), LINK], S('start_iso')), { next: 'tag_registered' });
  add('tag_registered', 'add_tag', 'Tag: webinar_registered', { tag_id: tag.webinar_registered }, { next: 'msg2_due' });
  add('t4_reinvite', 'send_template', 'Send next webinar link',
    tpl('sg_webinar_reinvite', [NAME, S('date_text'), S('time_text'), LINK], S('start_iso')), { next: 'msg2_due' });
  add('msg2_due', 'condition', 'Msg 2 still ahead?', isYes(S('msg2_due')), { yes: 'wait_msg2', no: 'wait_msg3' });
  add('wait_msg2', 'wait', 'Wait until Msg 2 (2 PM / 11 AM)', { amount: 1, unit: 'hours', until: S('msg2_iso') }, { next: 't2_msg2' });
  add('t2_msg2', 'send_template', 'Msg 2 Reminder',
    tpl('sg_webinar_reminder', [NAME, S('phrase'), S('date_text'), S('time_text'), LINK], S('msg3_iso')), { next: 'wait_msg3' });
  add('wait_msg3', 'wait', 'Wait until Msg 3 (7 PM / 2 PM)', { amount: 1, unit: 'hours', until: S('msg3_iso') }, { next: 't2_msg3' });
  add('t2_msg3', 'send_template', 'Msg 3 Starting in 1 hour',
    tpl('sg_webinar_reminder', [NAME, 'starting in 1 hour', S('date_text'), S('time_text'), LINK], S('start_iso')), { next: 'wait_checkin' });
  add('wait_checkin', 'wait', 'Wait until 7 AM next day', { amount: 12, unit: 'hours', until: S('checkin_iso') }, { next: 't3_checkin' });
  add('t3_checkin', 'send_template', 'Post-webinar check-in (menu)', tpl('sg_post_webinar_checkin', [NAME]), { next: 'reply_menu' });
  add('reply_menu', 'wait_for_reply', 'Wait for menu reply', { amount: 24, unit: 'hours' }, { replied: 'mark_menu', timeout: 'auto_reinvited' });

  // No response → send the next webinar link once and re-enter the
  // reminder loop; still nothing after that → nurture, by where they
  // dropped off (see the header).
  add('auto_reinvited', 'condition', 'Already re-invited?', isYes('{{ vars.auto_reinvite }}'), { yes: 'menu_cold', no: 'set_auto_reinvite' });
  add('set_auto_reinvite', 'set_variable', 'Re-invite (no response)', {
    assignments: [{ key: 'auto_reinvite', value: 'yes' }, { key: 'reschedule', value: 'yes' }],
  }, { next: 'schedule' });
  add('menu_cold', 'condition', 'Answered the menu before?', isYes('{{ vars.menu_replied }}'), { yes: 'c_slot', no: 'ever_replied' });
  add('ever_replied', 'condition', 'Replied since registering?', { kind: 'replied', since: 'start' }, { yes: 'b_slot', no: 'a_slot' });

  // ---------- Conversion menu (typed 1–4 or the template's buttons) ----------
  add('mark_menu', 'set_variable', 'Mark: answered the menu', { assignments: [{ key: 'menu_replied', value: 'yes' }] }, { next: 'menu' });
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

  // Payment link → up to 2 daytime nudges inside the 24-hour window →
  // Stage D nurture. Payment received = tag "paid" → the run stops (WON).
  add('pay_link', 'send_text', 'Send payment link', {
    text: `Great decision, ${NAME}! 🎉\n\nHere's your link to join Revibe:\n{{ vars.payment_link }}\n\nReply here if you have any questions.\n\n— Swapnil Gautam`,
  }, { next: 'tag_paylink' });
  add('tag_paylink', 'add_tag', 'Tag: payment_link_sent', { tag_id: tag.payment_link_sent }, { next: 'pay_plan' });
  // A plan error falls back to the plain checks below (window guard still applies).
  add('pay_plan', 'code', 'Plan nudges (daytime, inside 24h)', { code: paymentPlanCode }, { success: 'reply_pay', error: 'pay_n1_due' });
  add('reply_pay', 'wait_for_reply', 'Wait until nudge 1', { amount: 6, unit: 'hours', until: '{{ nodes.pay_plan.step1_iso }}' }, { replied: 'pay_reply', timeout: 'pay_has_plan' });
  // Runs that were already waiting here before this version have no plan yet.
  add('pay_has_plan', 'condition', 'Nudge plan made?', { kind: 'expression', left: '{{ nodes.pay_plan.end_iso }}', op: 'not_empty', right: '' }, { yes: 'pay_n1_due', no: 'pay_late' });
  add('pay_late', 'set_variable', 'Plan for an older run', { assignments: [{ key: 'pay_late', value: 'yes' }] }, { next: 'pay_plan' });
  add('pay_n1_due', 'condition', 'Nudge 1 fits the window?', notNo('{{ nodes.pay_plan.n1_ok }}'), { yes: 'pay_n1_open', no: 'pay_n2_due' });
  add('pay_n1_open', 'condition', '24h window still open?', { kind: 'window_open' }, { yes: 'pay_nudge1', no: 'd_slot' });
  add('pay_nudge1', 'send_text', 'Payment nudge 1', {
    text: `Hi ${NAME}, just checking in 😊 Your spot in Revibe is still open.\n\nComplete your enrollment here:\n{{ vars.payment_link }}\n\nAny questions? Just reply here.\n\n— Swapnil Gautam`,
  }, { next: 'reply_pay2' });
  add('reply_pay2', 'wait_for_reply', 'Wait until nudge 2', { amount: 12, unit: 'hours', until: '{{ nodes.pay_plan.step2_iso }}' }, { replied: 'pay_reply', timeout: 'pay_n2_due' });
  add('pay_n2_due', 'condition', 'Nudge 2 fits the window?', notNo('{{ nodes.pay_plan.n2_ok }}'), { yes: 'pay_n2_open', no: 'd_slot' });
  add('pay_n2_open', 'condition', '24h window still open?', { kind: 'window_open' }, { yes: 'pay_nudge2', no: 'd_slot' });
  add('pay_nudge2', 'send_text', 'Payment nudge 2', {
    text: `Hi ${NAME}, your payment link is still active:\n{{ vars.payment_link }}\n\nIf something is holding you back — instalments, what's included, start date — reply and I'll sort it personally.\n\n— Swapnil Gautam`,
  }, { next: 'reply_pay3' });
  add('reply_pay3', 'wait_for_reply', 'Wait until 24h after the link', { amount: 5, unit: 'hours', until: '{{ nodes.pay_plan.end_iso }}' }, { replied: 'pay_reply', timeout: 'd_slot' });
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
  add('reply_t5', 'wait_for_reply', 'Wait 48h after re-prompt', { amount: 48, unit: 'hours' }, { replied: 't5_menu', timeout: 'c_slot' });
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
  add('assign_owner', 'conversation', 'Human handoff (assign Swapnil)', { action: 'assign', user_id: ownerUserId }, { next: 'callback_msg' });
  add('callback_msg', 'send_text', 'Confirm callback', { text: `Thank you, ${NAME}! 🙏 My team will call you shortly.` }, { next: 'end' });

  // Callback not answered (started from the Callbacks page): tell them we
  // tried. "Call me again" → back to the team; "Not now" → Stage C
  // nurture; anything else → the conversion menu. No reply → the
  // request stays with the team (2nd "No answer" / 48h → Stage C).
  add('cb_missed', 'send_template', 'We tried calling you', tpl('sg_callback_missed', [NAME]), { next: 'cb_wait' });
  add('cb_wait', 'wait_for_reply', 'Wait 24h for a reply', { amount: 24, unit: 'hours' }, { replied: 'cb_reply', timeout: 'end' });
  add('cb_reply', 'switch', 'Reply to "we tried calling"', {
    value: lc,
    cases: [
      { op: 'contains', value: 'not now', label: 'Not now' },
      { op: 'contains', value: 'call', label: 'Call me again' },
    ],
  }, { case_0: 'c_slot', case_1: 'tag_callback', default: 'mark_menu' });

  // ---------- 15-day alternate-day nurture (11 AM IST) → CLOSED-LOST ----------
  //   x_slot → x_wait (until the slot; a reply leaves the nurture)
  //     → loop_x: each → [a_next] → x_send → x_slot …   done → closed_lost
  const stage = (key: string, label: string, template: string, params: string[], onReply: string, pre?: string) => {
    add(`${key}_slot`, 'code', `Stage ${key.toUpperCase()}: next 11 AM slot`, { code: nurtureSlotCode(key) }, { success: `${key}_wait`, error: `${key}_wait` });
    add(`${key}_wait`, 'wait_for_reply', `Stage ${key.toUpperCase()}: wait for 11 AM (or a reply)`,
      { amount: 2, unit: 'days', until: `{{ nodes.${key}_slot.at }}` }, { replied: onReply, timeout: `loop_${key}` });
    add(`loop_${key}`, 'loop', `Stage ${key.toUpperCase()} nurture (${label})`, { items: '{{ nodes.nurture_days }}', max: 8 }, { each: pre ?? `${key}_send`, done: 'tag_lost' });
    if (pre) add(pre, 'code', 'Next webinar (IST)', { code: scheduleCode(true) }, { success: `${key}_send` });
    add(`${key}_send`, 'send_template', template, tpl(template, params, `{{ nodes.${key}_slot.retry_until }}`), { next: `${key}_slot` });
  };
  stage('a', 'pre-webinar dropout', 'sg_nurture_prewebinar',
    [NAME, '{{ nodes.a_next.date_text }}', '{{ nodes.a_next.time_text }}', LINK], 'mark_menu', 'a_next');
  stage('b', 'post check-in cold', 'sg_nurture_postwebinar', [NAME], 'mark_menu');
  stage('c', 'conversion menu cold', 'sg_nurture_coldlead', [NAME], 'mark_menu');
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

/**
 * Where a run that is already parked on a nurture wait (from before
 * this version, timed at the old time of day) should resume: the next
 * 11 AM IST at or after 12h before its old time — about the same day,
 * now at 11 AM.
 */
export function realignedNurtureTime(oldNextRunAt: string): string | null {
  const old = Date.parse(oldNextRunAt);
  if (!Number.isFinite(old)) return null;
  const H = 3600e3, DAY = 864e5, IST = 5.5 * H;
  const from = old - 12 * H + IST;
  let at = Math.floor(from / DAY) * DAY + NURTURE_HOUR * H;
  if (at < from) at += DAY;
  return new Date(at - IST).toISOString();
}

/**
 * A run parked before payment nudge 2 from before this version, due at
 * night: move it to 9 AM IST (the window check still guards the send).
 * Daytime times are kept (null).
 */
export function realignedNudgeTime(oldNextRunAt: string): string | null {
  const old = Date.parse(oldNextRunAt);
  if (!Number.isFinite(old)) return null;
  const H = 3600e3, DAY = 864e5, IST = 5.5 * H;
  const ist = old + IST, day = Math.floor(ist / DAY) * DAY, h = (ist - day) / H;
  if (h >= DAY_START_HOUR && h < DAY_END_HOUR) return null;
  const at = h < DAY_START_HOUR ? day + DAY_START_HOUR * H : day + DAY + DAY_START_HOUR * H;
  return new Date(at - IST).toISOString();
}
