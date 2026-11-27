// One-off / re-runnable: apply the "not on WhatsApp" rule to every existing
// lead (src/lib/contacts/not-on-whatsapp.ts) — 2+ failures with 131026 and
// never reached → tag + stop their live journey runs.
//   npx jiti scripts/swapnil/backfill-not-on-whatsapp.ts          (dry run)
//   npx jiti scripts/swapnil/backfill-not-on-whatsapp.ts --apply
import { connect, ACCOUNT_ID } from './common';
import { markIfNotOnWhatsApp, UNDELIVERABLE_CODE, UNDELIVERABLE_THRESHOLD } from '../../src/lib/contacts/not-on-whatsapp';

async function main() {
  const apply = process.argv.includes('--apply');
  const db = await connect();
  const counts = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('journey_messages')
      .select('id, contact_id')
      .eq('account_id', ACCOUNT_ID)
      .eq('status', 'failed')
      .eq('error_code', UNDELIVERABLE_CODE)
      .order('id')
      .range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) counts.set(r.contact_id, (counts.get(r.contact_id) ?? 0) + 1);
    if (!data || data.length < 1000) break;
  }
  const candidates = [...counts].filter(([, n]) => n >= UNDELIVERABLE_THRESHOLD);
  console.log(`contacts with 131026 failures: ${counts.size}, with ${UNDELIVERABLE_THRESHOLD}+: ${candidates.length}`);
  let tagged = 0;
  for (const [id, n] of candidates) {
    const { data: c } = await db.from('contacts').select('name, phone').eq('id', id).maybeSingle();
    const ok = apply ? await markIfNotOnWhatsApp(db, ACCOUNT_ID, id) : null;
    if (ok) tagged++;
    console.log(`${apply ? (ok ? 'TAGGED ' : 'skipped') : 'would  '}  ${c?.phone ?? '?'}  ${c?.name ?? ''}  (${n} failed)`);
  }
  if (apply) console.log(`tagged ${tagged} / ${candidates.length} (skipped = was reached on WhatsApp before)`);
}
main().then(() => process.exit(0), (e) => (console.error(e), process.exit(1)));
