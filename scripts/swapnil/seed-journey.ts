// Builds the "Webinar Funnel — Swapnil Gautam" journey in Swapnil Gautam's
// account ONLY, following "Swapnil Gautam_Lead Lifecycle Flow.pdf" and the
// templates in SG_WhatsApp_Templates.pdf. The graph itself (and its timing
// rules) lives in ./journey-graph.ts.
//
//   npx jiti scripts/swapnil/seed-journey.ts               # dry run: validate + print
//   npx jiti scripts/swapnil/seed-journey.ts --insert      # create tags + insert as draft
//   npx jiti scripts/swapnil/seed-journey.ts --rebuild     # replace the existing journey's graph
//                                                          #   (keeps the values in its "Settings" step,
//                                                          #   moves runs parked on a nurture wait to 11 AM IST)
//   npx jiti scripts/swapnil/seed-journey.ts --update-code # refresh only its code steps
import { ACCOUNT_ID, OWNER_USER_ID, connect } from './common';
import { validateGraph, type JourneyGraph } from '../../src/lib/journeys/graph';
import { triggerColumns } from '../../src/lib/journeys/api';
import {
  JOURNEY_NAME,
  NUDGE2_WAIT_ID,
  NURTURE_WAIT_IDS,
  TAGS,
  buildJourney,
  realignedNudgeTime,
  realignedNurtureTime,
  type TagIds,
} from './journey-graph';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Runs parked from before this version: a nurture wait moves to 11 AM
 * IST (about the same day); a wait for payment nudge 2 that is due at
 * night moves to 9 AM. Only parked runs are touched, each guarded on its
 * current state.
 */
async function realignNurtureRuns(db: SupabaseClient, journeyId: string, write: boolean): Promise<void> {
  const { data, error } = await db
    .from('journey_enrollments')
    .select('id, current_node_id, next_run_at')
    .eq('journey_id', journeyId)
    .eq('status', 'waiting')
    .in('current_node_id', [...NURTURE_WAIT_IDS, NUDGE2_WAIT_ID]);
  if (error) throw error;
  let moved = 0;
  for (const run of data ?? []) {
    const to =
      run.current_node_id === NUDGE2_WAIT_ID
        ? realignedNudgeTime(String(run.next_run_at))
        : realignedNurtureTime(String(run.next_run_at));
    if (!to || to === run.next_run_at) continue;
    console.log(`  run ${run.id} @ ${run.current_node_id}: ${run.next_run_at} → ${to}`);
    if (!write) continue;
    const { error: upErr } = await db
      .from('journey_enrollments')
      .update({ next_run_at: to })
      .eq('id', run.id)
      .eq('status', 'waiting')
      .eq('current_node_id', run.current_node_id)
      .eq('next_run_at', run.next_run_at);
    if (upErr) throw upErr;
    moved++;
  }
  console.log(write ? `Moved ${moved} parked run(s).` : `${(data ?? []).length} parked run(s) checked (dry run — nothing changed).`);
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

  const graph = buildJourney(ids as TagIds, OWNER_USER_ID);
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
    await realignNurtureRuns(db, dupe.id, true);
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
    await realignNurtureRuns(db, dupe.id, false);
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
