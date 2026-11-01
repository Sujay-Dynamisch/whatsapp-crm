// ============================================================
// Callback follow-ups (migration 059): what happens when a callback
// request doesn't work out.
//
//   "No answer"  → the journey's "we tried calling you" step
//                  (trigger setting callback_missed_node); after the
//                  limit (callback_no_answer_limit, default 2) the lead
//                  goes back to nurture instead.
//   "Back to nurture" (button) / 48h with no action after a "No answer"
//                → request closed, lead back at callback_return_node.
//   Still "New" after 4h → owners/admins get a reminder notification.
//
// The lead resumes in the journey they last ran, with that run's
// settings (links, texts) carried over. Opted-out leads and leads with
// one of the journey's exit tags (paid / closed) are never messaged.
// Called with the service-role client. Never throws from the tick.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { accountHasFeature } from '@/lib/features-server';
import { enrollContact, type JourneyDeps, type JourneyRow } from '@/lib/journeys/engine';
import { findTrigger, type JourneyGraph, type TriggerConfig } from '@/lib/journeys/graph';

export const CALLBACK_TAG = 'callback_requested';
/** A request still "New" this long gets a reminder. */
export const REMINDER_AFTER_MS = 4 * 3600_000;
/** A "No answer" left this long without another try → back to nurture. */
export const STALE_NO_ANSWER_MS = 48 * 3600_000;
export const DEFAULT_NO_ANSWER_LIMIT = 2;

export type FollowUpKind = 'missed' | 'return';
export type FollowUpReason =
  | 'not_in_journey' // the lead never ran a journey with callback follow-ups
  | 'not_configured' // that journey has no step for this follow-up
  | 'opted_out'
  | 'closed' // paid / closed (one of the journey's exit tags)
  | 'busy' // their run is executing a step right now — try again
  | 'start_failed';

export interface FollowUpResult {
  started: boolean;
  reason?: FollowUpReason;
  journeyId?: string;
}

interface CallbackRow {
  id: string;
  account_id: string;
  contact_id: string;
  conversation_id: string | null;
  status: string;
  note: string | null;
  no_answer_count: number;
  handled_at: string | null;
  requested_at: string;
}

interface RunRow {
  id: string;
  journey_id: string;
  status: string;
  entered_at: string;
  context: Record<string, unknown> | null;
}

const cfgOf = (j: Pick<JourneyRow, 'graph'>) => (findTrigger(j.graph)?.config ?? {}) as TriggerConfig;

/** The active journey with callback follow-ups this contact ran most recently, and that run. */
async function journeyFor(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<{ journey: JourneyRow; last: RunRow } | null> {
  const { data: journeys } = await db.from('journeys').select('*').eq('account_id', accountId).eq('status', 'active');
  const usable = ((journeys ?? []) as JourneyRow[]).filter((j) => {
    const c = cfgOf(j);
    return Boolean(c.callback_return_node || c.callback_missed_node);
  });
  if (!usable.length) return null;
  const { data: runs } = await db
    .from('journey_enrollments')
    .select('id, journey_id, status, entered_at, context')
    .eq('contact_id', contactId)
    .in('journey_id', usable.map((j) => j.id));
  const latest = ((runs ?? []) as RunRow[]).sort((a, b) => Date.parse(b.entered_at) - Date.parse(a.entered_at))[0];
  if (!latest) return null;
  return { journey: usable.find((j) => j.id === latest.journey_id)!, last: latest };
}

/** Ids of the steps reachable from `start` (their old outputs would be stale). */
function reachable(graph: JourneyGraph, start: string): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    for (const t of Object.values(byId.get(id)!.next ?? {})) if (t) stack.push(t);
  }
  return seen;
}

/** Why this contact must not be messaged by `journey`, or null. */
async function blocked(db: SupabaseClient, journey: JourneyRow, contactId: string): Promise<FollowUpReason | null> {
  const { data } = await db.from('contact_tags').select('tag_id, tags(name)').eq('contact_id', contactId);
  const exit = cfgOf(journey).exit_tag_ids ?? [];
  for (const row of (data ?? []) as { tag_id: string; tags?: { name?: string } | { name?: string }[] | null }[]) {
    const t = Array.isArray(row.tags) ? row.tags[0] : row.tags;
    if ((t?.name ?? '').trim().toLowerCase() === 'unsubscribe') return 'opted_out';
    if (exit.includes(row.tag_id)) return 'closed';
  }
  return null;
}

/**
 * Put the contact back into their journey at the "we tried calling"
 * step ('missed') or the nurture step ('return'). Any parked run of
 * that journey is ended first; the new run carries the last run's
 * variables and the outputs of steps it won't re-run.
 */
export async function startFollowUp(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; kind: FollowUpKind },
  deps: JourneyDeps
): Promise<FollowUpResult> {
  const found = await journeyFor(db, args.accountId, args.contactId);
  if (!found) return { started: false, reason: 'not_in_journey' };
  const { journey, last } = found;
  const cfg = cfgOf(journey);
  const startAt = args.kind === 'missed' ? cfg.callback_missed_node : cfg.callback_return_node;
  if (!startAt || !journey.graph.nodes.some((n) => n.id === startAt)) {
    return { started: false, reason: 'not_configured', journeyId: journey.id };
  }
  const stop = await blocked(db, journey, args.contactId);
  if (stop) return { started: false, reason: stop, journeyId: journey.id };

  const { data: live } = await db
    .from('journey_enrollments')
    .select('id, status')
    .eq('journey_id', journey.id)
    .eq('contact_id', args.contactId)
    .in('status', ['active', 'waiting']);
  if ((live ?? []).some((r) => r.status === 'active')) return { started: false, reason: 'busy', journeyId: journey.id };
  if (live?.length) {
    await db
      .from('journey_enrollments')
      .update({
        status: 'exited',
        wait_kind: null,
        locked_at: null,
        last_error: 'Callback follow-up — restarted',
        completed_at: deps.now().toISOString(),
      })
      .in('id', live.map((r) => r.id))
      .eq('status', 'waiting');
  }

  const prev = (last.context ?? {}) as { vars?: Record<string, unknown>; nodes?: Record<string, unknown> };
  const ahead = reachable(journey.graph, startAt);
  const nodes = Object.fromEntries(Object.entries(prev.nodes ?? {}).filter(([id]) => !ahead.has(id)));
  const r = await enrollContact(
    db,
    journey,
    args.contactId,
    deps,
    {
      trigger: 'callback',
      trigger_data: { type: 'callback', followup: args.kind },
      // They asked for a call, so they did answer the menu.
      vars: { ...(prev.vars ?? {}), menu_replied: 'yes' },
      nodes,
    },
    { reentry: true, startAt }
  );
  return r.enrolled ? { started: true, journeyId: journey.id } : { started: false, reason: 'start_failed', journeyId: journey.id };
}

async function removeCallbackTag(db: SupabaseClient, accountId: string, contactId: string) {
  const { data: tag } = await db.from('tags').select('id').eq('account_id', accountId).ilike('name', CALLBACK_TAG).limit(1).maybeSingle();
  if (tag) await db.from('contact_tags').delete().eq('contact_id', contactId).eq('tag_id', tag.id);
}

async function notifyAdmins(
  db: SupabaseClient,
  req: Pick<CallbackRow, 'account_id' | 'contact_id' | 'conversation_id'>,
  type: 'callback_overdue' | 'callback_returned',
  title: string
) {
  const { data: contact } = await db.from('contacts').select('name, phone').eq('id', req.contact_id).maybeSingle();
  const name = String(contact?.name ?? '').trim();
  const phone = String(contact?.phone ?? '');
  const body = name && name !== phone ? `${name} · ${phone}` : phone || name;
  const { data: admins } = await db.from('profiles').select('user_id, account_role').eq('account_id', req.account_id);
  const rows = ((admins ?? []) as { user_id: string; account_role?: string }[])
    .filter((p) => p.account_role === 'owner' || p.account_role === 'admin')
    .map((p) => ({
      account_id: req.account_id,
      user_id: p.user_id,
      type,
      conversation_id: req.conversation_id,
      contact_id: req.contact_id,
      title,
      body,
    }));
  if (rows.length) await db.from('notifications').insert(rows);
}

/**
 * Close the request and put the lead back into nurture. `auto`: the
 * "No answer" limit or the 48h rule did it (admins are told). When the
 * lead can't go back (not in a journey, opted out…) the request is left
 * as it is and the reason returned.
 */
export async function returnToNurture(
  db: SupabaseClient,
  req: CallbackRow,
  deps: JourneyDeps,
  mode: 'manual' | 'auto'
): Promise<FollowUpResult> {
  const r = await startFollowUp(db, { accountId: req.account_id, contactId: req.contact_id, kind: 'return' }, deps);
  if (!r.started) return r;
  const now = deps.now().toISOString();
  await db
    .from('callback_requests')
    .update({
      status: 'done',
      handled_at: now,
      updated_at: now,
      note: (req.note ? `${req.note} · ` : '') + (mode === 'auto' ? 'Back to nurture (automatic)' : 'Back to nurture'),
    })
    .eq('id', req.id);
  await removeCallbackTag(db, req.account_id, req.contact_id);
  if (mode === 'auto') await notifyAdmins(db, req, 'callback_returned', 'Callback not reached — lead back in nurture');
  return r;
}

/** Limit of "No answer" marks for this contact's journey. */
async function noAnswerLimit(db: SupabaseClient, accountId: string, contactId: string): Promise<number> {
  const found = await journeyFor(db, accountId, contactId);
  const lim = Number(found ? cfgOf(found.journey).callback_no_answer_limit : NaN);
  return Number.isInteger(lim) && lim >= 1 ? lim : DEFAULT_NO_ANSWER_LIMIT;
}

export type NoAnswerAction = 'messaged' | 'returned' | 'none';

/**
 * The team just marked a callback "No answer" (no_answer_count already
 * incremented): below the limit, tell the lead we tried; at the limit,
 * back to nurture.
 */
export async function handleNoAnswer(
  db: SupabaseClient,
  requestId: string,
  deps: JourneyDeps
): Promise<{ action: NoAnswerAction; reason?: FollowUpReason; count: number; limit: number }> {
  const { data } = await db.from('callback_requests').select('*').eq('id', requestId).maybeSingle();
  const req = data as CallbackRow | null;
  if (!req) return { action: 'none', count: 0, limit: DEFAULT_NO_ANSWER_LIMIT };
  const limit = await noAnswerLimit(db, req.account_id, req.contact_id);
  const count = Number(req.no_answer_count) || 0;
  if (count >= limit) {
    const r = await returnToNurture(db, req, deps, 'auto');
    return { action: r.started ? 'returned' : 'none', reason: r.reason, count, limit };
  }
  const r = await startFollowUp(db, { accountId: req.account_id, contactId: req.contact_id, kind: 'missed' }, deps);
  return { action: r.started ? 'messaged' : 'none', reason: r.reason, count, limit };
}

export interface FollowUpReport {
  reminded: number;
  returned: number;
  errors: string[];
}

/** Every minute (journeyTick): reminders for waiting requests, 48h rule for "No answer". */
export async function runCallbackFollowUps(db: SupabaseClient, deps: JourneyDeps): Promise<FollowUpReport> {
  const report: FollowUpReport = { reminded: 0, returned: 0, errors: [] };
  const now = deps.now();
  const enabled = new Map<string, boolean>();
  const on = async (accountId: string) => {
    if (!enabled.has(accountId)) enabled.set(accountId, await accountHasFeature(db, accountId, 'callbacks'));
    return enabled.get(accountId)!;
  };

  // Still "New" after 4h → remind owners/admins once.
  const { data: waiting } = await db
    .from('callback_requests')
    .select('*')
    .eq('status', 'new')
    .is('reminded_at', null)
    .lte('requested_at', new Date(now.getTime() - REMINDER_AFTER_MS).toISOString())
    .limit(100);
  for (const req of (waiting ?? []) as CallbackRow[]) {
    try {
      if (!(await on(req.account_id))) continue;
      const { data: claimed } = await db
        .from('callback_requests')
        .update({ reminded_at: now.toISOString() })
        .eq('id', req.id)
        .is('reminded_at', null)
        .select('id');
      if (!claimed?.length) continue;
      await notifyAdmins(db, req, 'callback_overdue', 'Callback waiting 4+ hours');
      report.reminded++;
    } catch (err) {
      report.errors.push(`remind ${req.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // "No answer" and nobody tried again for 48h → back to nurture.
  const { data: stale } = await db
    .from('callback_requests')
    .select('*')
    .eq('status', 'no_answer')
    .lte('handled_at', new Date(now.getTime() - STALE_NO_ANSWER_MS).toISOString())
    .limit(50);
  for (const req of (stale ?? []) as CallbackRow[]) {
    try {
      if (!(await on(req.account_id))) continue;
      // Claim: push handled_at forward so a parallel / failed attempt waits another 48h.
      const { data: claimed } = await db
        .from('callback_requests')
        .update({ handled_at: now.toISOString() })
        .eq('id', req.id)
        .eq('status', 'no_answer')
        .eq('handled_at', req.handled_at)
        .select('id');
      if (!claimed?.length) continue;
      const r = await returnToNurture(db, req, deps, 'auto');
      if (r.started) report.returned++;
      else if (r.reason !== 'busy') {
        await notifyAdmins(db, req, 'callback_overdue', 'Callback not reached for 48h — please follow up');
      }
    } catch (err) {
      report.errors.push(`stale ${req.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return report;
}
