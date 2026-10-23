// Switches the webinar journey's T1–T4 steps from the account's older
// templates to the PDF-spec ones (header + buttons) — only for templates
// Meta has APPROVED. Safe to re-run until all four are switched.
//
//   npx jiti scripts/swapnil/use-pdf-templates.ts            # show what would change
//   npx jiti scripts/swapnil/use-pdf-templates.ts --apply    # update the journey
import { ACCOUNT_ID, connect } from './common';

const JOURNEY_NAME = 'Webinar Funnel — Swapnil Gautam';
const SWAP: Record<string, string> = {
  registration_confirmation: 'sg_webinar_confirmation',
  reminder_for_webinar: 'sg_webinar_reminder',
  trigger_sent_at_7: 'sg_post_webinar_checkin',
  triggered_when_lead_selects_option_3: 'sg_webinar_reinvite',
};

async function main() {
  const apply = process.argv.includes('--apply');
  const db = await connect();

  const { data: tpls } = await db
    .from('message_templates')
    .select('name, status')
    .eq('account_id', ACCOUNT_ID)
    .in('name', Object.values(SWAP));
  const approved = new Set((tpls ?? []).filter((t) => t.status === 'APPROVED').map((t) => t.name));
  for (const name of Object.values(SWAP)) {
    console.log(`${name}: ${(tpls ?? []).find((t) => t.name === name)?.status ?? 'not created'}`);
  }

  const { data: journey, error } = await db
    .from('journeys')
    .select('id, graph')
    .eq('account_id', ACCOUNT_ID)
    .eq('name', JOURNEY_NAME)
    .single();
  if (error || !journey) throw new Error(`Journey "${JOURNEY_NAME}" not found in account.`);

  let changed = 0;
  for (const node of journey.graph.nodes as { id: string; type: string; config: { template_name?: string } }[]) {
    const to = node.type === 'send_template' ? SWAP[node.config.template_name ?? ''] : undefined;
    if (!to || !approved.has(to)) continue;
    console.log(`  ${node.id}: ${node.config.template_name} → ${to}`);
    node.config.template_name = to;
    changed++;
  }
  if (!changed) return console.log('Nothing to switch (new templates not approved yet, or already switched).');
  if (!apply) return console.log(`${changed} step(s) would change. Re-run with --apply.`);

  const { error: upErr } = await db
    .from('journeys')
    .update({ graph: journey.graph, updated_at: new Date().toISOString() })
    .eq('id', journey.id)
    .eq('account_id', ACCOUNT_ID);
  if (upErr) throw upErr;
  console.log(`Updated ${changed} step(s) in journey ${journey.id}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
