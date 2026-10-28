// Read-only: for every send_template step in the webinar journey whose
// template has quick-reply buttons, show what the journey does after a tap.
//   npx jiti scripts/swapnil/audit-buttons.ts
import { ACCOUNT_ID, connect } from './common';

async function main() {
  const db = await connect();
  const { data: tpls } = await db.from('message_templates').select('name, status, category, buttons').eq('account_id', ACCOUNT_ID);
  const { data: j } = await db.from('journeys').select('id, graph').eq('account_id', ACCOUNT_ID).eq('name', 'Webinar Funnel — Swapnil Gautam').single();
  const nodes = j!.graph.nodes as { id: string; type: string; config: Record<string, unknown>; next?: Record<string, string> }[];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  console.log('TEMPLATES WITH BUTTONS');
  for (const t of tpls ?? []) {
    const b = (t.buttons ?? []) as { type?: string; text?: string }[];
    if (b.length) console.log(`  ${t.name} [${t.status}/${t.category}]: ${b.map((x) => `${x.type}:${x.text}`).join(' | ')}`);
  }
  console.log('\nJOURNEY STEPS USING THEM');
  for (const n of nodes.filter((n) => n.type === 'send_template')) {
    const t = (tpls ?? []).find((x) => x.name === n.config.template_name);
    const b = ((t?.buttons ?? []) as { text?: string }[]).map((x) => x.text);
    if (!b.length) continue;
    const walk: string[] = [];
    let cur = n.next ? Object.values(n.next)[0] : undefined;
    for (let i = 0; cur && i < 4; i++) {
      const s = byId.get(cur)!;
      walk.push(`${s.id}(${s.type})`);
      if (s.type === 'switch' || s.type === 'wait_for_reply') {
        console.log(`  ${n.id} → ${n.config.template_name} buttons=[${b.join(', ')}]\n     path: ${walk.join(' → ')}\n     ${s.type} config: ${JSON.stringify(s.config).slice(0, 600)}\n     next: ${JSON.stringify(s.next)}`);
        if (s.type === 'switch') break;
      }
      cur = s.next ? Object.values(s.next)[0] : undefined;
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
