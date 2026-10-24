// Fast end-to-end test of the webinar journey in Swapnil Gautam's account.
// Copies the live "Webinar Funnel — Swapnil Gautam" graph into
// "[TEST] Webinar Funnel" (manual trigger, re-entry allowed) with the
// timings squeezed: Msg 2 at +2 min, Msg 3 at +4 min, check-in at +6 min,
// every reply wait 3 min, nurture every 2 min × 2 sends.
//
//   npx jiti scripts/swapnil/test-journey.ts                      # create/refresh the test journey
//   npx jiti scripts/swapnil/test-journey.ts --enroll +919359742537   # …and start a run for that number
import { ACCOUNT_ID, OWNER_USER_ID, connect } from './common';
import { validateGraph, type JourneyGraph, type JourneyNode } from '../../src/lib/journeys/graph';

const LIVE_NAME = 'Webinar Funnel — Swapnil Gautam';
const TEST_NAME = '[TEST] Webinar Funnel';

// Same outputs as the real "Webinar schedule" step; only the send times move.
const TEST_SCHEDULE = `const M = 60e3;
const now = Date.now();
const ist = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 19) + '+05:30';
const d = new Date(now + 5.5 * 3600e3);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
return {
  added_ist: String(contact.created_at_ist || ''),
  date_text: DAYS[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(),
  time_text: weekend ? '3:00 PM IST' : '8:00 PM IST',
  phrase: weekend ? 'this afternoon at 3:00 PM' : 'coming up tonight at 8:00 PM',
  start_iso: ist(now + 5 * M),
  msg2_due: 'yes',
  msg2_iso: ist(now + 2 * M),
  msg3_iso: ist(now + 4 * M),
  checkin_iso: ist(now + 6 * M),
};`;

function squeeze(live: JourneyGraph): JourneyGraph {
  const nodes = live.nodes.map((n) => structuredClone(n) as JourneyNode);
  for (const n of nodes) {
    const c = n.config as Record<string, unknown>;
    if (n.type === 'trigger') n.config = { trigger_type: 'manual' } as JourneyNode['config'];
    if (n.type === 'code' && (n.id === 'schedule' || n.id === 'a_next')) c.code = TEST_SCHEDULE;
    if (n.type === 'wait_for_reply') Object.assign(c, n.id.endsWith('_wait') ? { amount: 2, unit: 'minutes' } : { amount: 3, unit: 'minutes' });
    if (n.type === 'loop') c.max = 2;
  }
  return { nodes };
}

async function main() {
  const db = await connect();
  const { data: live, error } = await db.from('journeys').select('graph').eq('account_id', ACCOUNT_ID).eq('name', LIVE_NAME).single();
  if (error || !live) throw new Error(`Live journey "${LIVE_NAME}" not found.`);

  const graph = squeeze(live.graph as JourneyGraph);
  const issues = validateGraph(graph);
  if (issues.length) throw new Error('Validation: ' + issues.map((i) => `${i.nodeId}: ${i.message}`).join('; '));

  const row = {
    account_id: ACCOUNT_ID,
    name: TEST_NAME,
    description: 'Fast test copy of the webinar funnel (minutes instead of days). Safe to delete.',
    status: 'active',
    trigger_type: 'manual',
    trigger_config: {},
    graph,
    allow_reentry: true,
    created_by: OWNER_USER_ID,
    activated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data: existing } = await db.from('journeys').select('id').eq('account_id', ACCOUNT_ID).eq('name', TEST_NAME).maybeSingle();
  const { data: saved, error: saveErr } = existing
    ? await db.from('journeys').update(row).eq('id', existing.id).eq('account_id', ACCOUNT_ID).select('*').single()
    : await db.from('journeys').insert(row).select('*').single();
  if (saveErr) throw saveErr;
  console.log(`${existing ? 'Refreshed' : 'Created'} test journey ${saved.id} (${graph.nodes.length} steps).`);

  const i = process.argv.indexOf('--enroll');
  if (i < 0) return;
  const phone = (process.argv[i + 1] ?? '').replace(/[^\d]/g, '');
  const { data: contacts } = await db.from('contacts').select('id, name, phone').eq('account_id', ACCOUNT_ID);
  let contact = (contacts ?? []).find((c) => String(c.phone).replace(/[^\d]/g, '') === phone);
  if (!contact) {
    // Direct insert: doesn't fire the live journey's contact_created trigger.
    const { data, error: insErr } = await db
      .from('contacts')
      .insert({ account_id: ACCOUNT_ID, user_id: OWNER_USER_ID, name: 'Journey Test', phone: `+${phone}` })
      .select('id, name, phone')
      .single();
    if (insErr) throw new Error(`Create contact: ${insErr.message}`);
    contact = data;
    console.log(`Created test contact +${phone} in Swapnil's account.`);
  }

  // Clear a still-live test run for this contact so a fresh one can start.
  await db.from('journey_enrollments').update({ status: 'exited' }).eq('journey_id', saved.id).eq('contact_id', contact.id).in('status', ['active', 'waiting']);

  const { enrollContact, startContext } = await import('../../src/lib/journeys/engine');
  const { liveJourneyDeps } = await import('../../src/lib/journeys/dispatch');
  const r = await enrollContact(db, saved, contact.id, liveJourneyDeps, startContext('manual'));
  console.log(`Enroll ${contact.name ?? ''} (${contact.phone}):`, r.enrolled ? `started → ${r.outcome ?? ''}` : `not started (${r.reason})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
