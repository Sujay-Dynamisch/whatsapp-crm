// Read-only: did these contacts reach the webinar journey's nurture, and
// what happened to every message it sent them? Changes nothing.
//
//   npx jiti scripts/swapnil/check-nurture.ts "Sujay Khedekar" "Aditi Johari"
//   npx jiti scripts/swapnil/check-nurture.ts +919800000001
//
// Each argument matches a contact by name (contains, any case) or phone.
import { ACCOUNT_ID, connect } from './common';
import { JOURNEY_NAME } from './journey-graph';

const STAGES: Record<string, string> = {
  a: 'Stage A — pre-webinar dropout (sg_nurture_prewebinar)',
  b: 'Stage B — post check-in cold (sg_nurture_postwebinar)',
  c: 'Stage C — conversion menu cold (sg_nurture_coldlead)',
  d: 'Stage D — payment abandoned (sg_nurture_payment)',
};

const ist = (iso: unknown) =>
  iso ? new Date(Date.parse(String(iso)) + 5.5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' IST' : '—';

/** Which nurture stage a step belongs to (a_wait, loop_b, c_send, d_slot, a_next …). */
function stageOf(nodeId: string | null | undefined): string | null {
  const m = /^(?:loop_)?([abcd])_(?:slot|wait|send|next)$|^loop_([abcd])$/.exec(nodeId ?? '');
  return m ? (m[1] ?? m[2]) : null;
}

async function main() {
  const queries = process.argv.slice(2);
  if (!queries.length) throw new Error('Usage: check-nurture.ts "<name or phone>" […]');
  const db = await connect();

  const { data: journey } = await db.from('journeys').select('id, status, graph').eq('account_id', ACCOUNT_ID).eq('name', JOURNEY_NAME).maybeSingle();
  if (!journey) throw new Error(`Journey "${JOURNEY_NAME}" not found.`);
  const labels = new Map(((journey.graph as { nodes: { id: string; label?: string }[] }).nodes ?? []).map((n) => [n.id, n.label ?? n.id]));
  console.log(`Journey ${journey.id} — status: ${journey.status}\n`);

  const { data: tagRows } = await db.from('tags').select('id, name').eq('account_id', ACCOUNT_ID);
  const tagName = new Map((tagRows ?? []).map((t) => [t.id as string, t.name as string]));

  for (const q of queries) {
    const digits = q.replace(/\D/g, '');
    let req = db.from('contacts').select('id, name, phone, created_at_ist').eq('account_id', ACCOUNT_ID);
    req = digits.length >= 8 ? req.ilike('phone', `%${digits.slice(-10)}%`) : req.ilike('name', `%${q.trim()}%`);
    const { data: contacts, error } = await req.limit(10);
    if (error) throw error;
    console.log(`=== "${q}" — ${contacts?.length ?? 0} contact(s)`);
    if (!contacts?.length) {
      console.log('  Not found in this account (check the spelling or search by phone).\n');
      continue;
    }

    for (const c of contacts) {
      const { data: ct } = await db.from('contact_tags').select('tag_id').eq('contact_id', c.id);
      const tags = (ct ?? []).map((r) => tagName.get(r.tag_id as string) ?? r.tag_id);
      console.log(`\n${c.name ?? '(no name)'}  ${c.phone}  — added ${c.created_at_ist ?? '—'} IST`);
      console.log(`  Tags: ${tags.length ? tags.join(', ') : 'none'}`);

      const { data: runs } = await db
        .from('journey_enrollments')
        .select('id, status, current_node_id, wait_kind, next_run_at, entered_at, completed_at, last_error')
        .eq('journey_id', journey.id)
        .eq('contact_id', c.id)
        .order('entered_at', { ascending: true });
      if (!runs?.length) {
        console.log('  ✗ Never entered the webinar journey (not created via the website / API, or created before it was active).');
        continue;
      }

      for (const r of runs) {
        const { data: ev } = await db.from('journey_events').select('node_id, event').eq('enrollment_id', r.id).eq('event', 'entered');
        const stages = [...new Set((ev ?? []).map((e) => stageOf(e.node_id as string)).filter(Boolean))] as string[];
        console.log(`  Run ${r.id}  started ${ist(r.entered_at)}`);
        console.log(`    Status: ${r.status}  at "${labels.get(r.current_node_id as string) ?? r.current_node_id}"`);
        if (r.status === 'waiting') console.log(`    Next step: ${ist(r.next_run_at)} (${r.wait_kind === 'reply' ? 'or earlier if they reply' : 'timer'})`);
        if (r.completed_at) console.log(`    Ended: ${ist(r.completed_at)}`);
        if (r.last_error) console.log(`    Reason: ${r.last_error}`);
        console.log(
          stages.length
            ? `    ✓ In nurture: ${stages.map((s) => STAGES[s]).join('; then ')}`
            : '    ✗ Not in nurture (yet).'
        );

        const { data: msgs } = await db
          .from('journey_messages')
          .select('created_at, node_id, kind, template_name, status, error_code, error_title, resolved, attempt')
          .eq('enrollment_id', r.id)
          .order('created_at', { ascending: true });
        if (!msgs?.length) {
          console.log('    Messages: none logged');
          continue;
        }
        console.log('    Messages:');
        for (const m of msgs) {
          const what = m.template_name ?? m.kind;
          const err = m.status === 'failed' ? `  ✗ (${m.error_code ?? '?'}) ${String(m.error_title ?? '').slice(0, 90)}${m.resolved ? ` → ${m.resolved}` : ''}` : '';
          console.log(`      ${ist(m.created_at)}  ${String(what).padEnd(26)} ${String(m.kind).padEnd(8)} ${m.status}${err}`);
        }
      }
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
