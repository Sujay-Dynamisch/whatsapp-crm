// ============================================================
// Put leads whose journey ended early back into it.
//
// The journey should end only when the lead pays, is closed (Not
// proceeding / manually closed), opts out, or finishes the 15-day nurture
// (closed_lost). Before the fix, a callback request ("My team will call
// you") or an unanswered "we tried calling you" ended the run. This finds
// open leads with no running journey and restarts them at the callback
// router (cb_after): back to their webinar reminders if the session is
// still ahead, otherwise into nurture (Stage D with a payment link, else C).
// Nothing is sent right away — the next message goes at its normal time.
//
// Run AFTER `seed-journey.ts --rebuild` (the live journey needs cb_after).
//   npx jiti scripts/swapnil/resume-ended-leads.ts           (dry run)
//   npx jiti scripts/swapnil/resume-ended-leads.ts --apply
// ============================================================

import { ACCOUNT_ID, connect } from './common';

const STOP_TAGS = ['paid', 'manually_closed', 'closed_lost', 'unsubscribe'];

async function main() {
  const apply = process.argv.includes('--apply');
  const db = await connect();
  const { startFollowUp } = await import('../../src/lib/callbacks/followups');
  const { liveJourneyDeps } = await import('../../src/lib/journeys/dispatch');

  const { data: journey } = await db.from('journeys').select('id, graph').eq('account_id', ACCOUNT_ID).eq('status', 'active').limit(1).single();
  const trigger = (journey!.graph as { nodes: { type: string; config: Record<string, unknown> }[] }).nodes.find((n) => n.type === 'trigger')!;
  if (trigger.config.callback_return_node !== 'cb_after') {
    console.log('The live journey is not rebuilt yet (no cb_after). Run: npx jiti scripts/swapnil/seed-journey.ts --rebuild');
    if (apply) process.exit(1);
  }

  const runs: { contact_id: string; status: string; entered_at: string }[] = [];
  for (let o = 0; ; o += 1000) {
    const { data } = await db.from('journey_enrollments').select('contact_id, status, entered_at').eq('journey_id', journey!.id).range(o, o + 999);
    runs.push(...((data ?? []) as typeof runs));
    if (!data || data.length < 1000) break;
  }
  const live = new Set(runs.filter((r) => r.status === 'waiting' || r.status === 'active').map((r) => r.contact_id));
  const ended = [...new Set(runs.filter((r) => !live.has(r.contact_id)).map((r) => r.contact_id))];

  const candidates: { id: string; name: string }[] = [];
  for (let i = 0; i < ended.length; i += 100) {
    const ids = ended.slice(i, i + 100);
    const [{ data: contacts }, { data: tags }] = await Promise.all([
      db.from('contacts').select('id, name, phone').in('id', ids),
      db.from('contact_tags').select('contact_id, tags(name)').in('contact_id', ids),
    ]);
    const stopped = new Set(
      (tags ?? [])
        .filter((t) => STOP_TAGS.includes(String((Array.isArray(t.tags) ? t.tags[0] : (t.tags as { name?: string } | null))?.name ?? '').toLowerCase()))
        .map((t) => t.contact_id as string)
    );
    for (const c of contacts ?? []) if (!stopped.has(c.id as string)) candidates.push({ id: c.id as string, name: (c.name as string) || (c.phone as string) });
  }

  console.log(`Leads whose journey ended early (not paid / closed / lost / opted out): ${candidates.length}${apply ? '' : ' (dry run)'}`);
  let ok = 0;
  for (const c of candidates) {
    if (!apply) {
      console.log(` - ${c.name}`);
      continue;
    }
    const r = await startFollowUp(db, { accountId: ACCOUNT_ID, contactId: c.id, kind: 'return' }, liveJourneyDeps);
    console.log(` - ${c.name}: ${r.started ? 'back in the journey' : `not restarted (${r.reason})`}`);
    if (r.started) ok++;
  }
  if (apply) console.log(`Restarted: ${ok} of ${candidates.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
