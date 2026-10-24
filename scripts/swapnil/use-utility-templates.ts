// Switches the webinar journey's confirmation / reminder / re-invite steps
// to the UTILITY templates (not subject to Meta's 131049 per-user
// marketing limit) — only for templates Meta APPROVED and kept as
// Utility. Safe to re-run.
//
//   npx jiti scripts/swapnil/use-utility-templates.ts            # show what would change
//   npx jiti scripts/swapnil/use-utility-templates.ts --apply    # update the journey
import { ACCOUNT_ID, connect } from './common';

const JOURNEY_NAME = 'Webinar Funnel — Swapnil Gautam';
const SWAP: Record<string, string> = {
  sg_webinar_confirmation: 'sg_registration_confirmed',
  registration_confirmation: 'sg_registration_confirmed',
  sg_webinar_reminder: 'sg_webinar_session_reminder',
  reminder_for_webinar: 'sg_webinar_session_reminder',
  sg_webinar_reinvite: 'sg_webinar_session_rebooked',
  triggered_when_lead_selects_option_3: 'sg_webinar_session_rebooked',
};

async function main() {
  const apply = process.argv.includes('--apply');
  const db = await connect();

  const targets = [...new Set(Object.values(SWAP))];
  const { data: tpls } = await db
    .from('message_templates')
    .select('name, status, category')
    .eq('account_id', ACCOUNT_ID)
    .in('name', targets);
  const ready = new Set<string>();
  for (const name of targets) {
    const t = (tpls ?? []).find((x) => x.name === name);
    const ok = t?.status === 'APPROVED' && String(t.category).toLowerCase() === 'utility';
    if (ok) ready.add(name);
    console.log(`${name}: ${t ? `${t.status} / ${t.category}` : 'not created'}${t && t.status === 'APPROVED' && !ok ? ' — Meta changed it to Marketing, NOT switching' : ''}`);
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
    if (!to || !ready.has(to)) continue;
    console.log(`  ${node.id}: ${node.config.template_name} → ${to}`);
    node.config.template_name = to;
    changed++;
  }
  if (!changed) return console.log('Nothing to switch yet (Utility templates not approved as Utility, or already switched).');
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
