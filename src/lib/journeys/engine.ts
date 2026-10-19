// ============================================================
// Journey engine (migration 050).
//
// Moves one enrollment through the graph until it reaches a wait, an
// end, or a failure. Every node entered and every slot taken is logged
// to journey_events (the canvas conversion numbers).
//
//   enrollContact()   start a contact at the trigger
//   resumeOnReply()   a waiting "wait for reply" got its reply
//   runJourneyTick()  timers / reply timeouts / crashed steps (Cloud
//                     Scheduler, once a minute)
//
// Side effects go through `JourneyDeps` so tests drive the whole engine
// against an in-memory database without Meta.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  durationMs,
  findTrigger,
  slotsFor,
  type JourneyGraph,
  type JourneyNode,
  type JourneyTriggerType,
  type NodeConfigs,
} from './graph';

export interface JourneyRow {
  id: string;
  account_id: string;
  status: 'draft' | 'active' | 'paused';
  trigger_type: JourneyTriggerType;
  trigger_config: { tag_id?: string; button_text?: string } | null;
  graph: JourneyGraph;
  allow_reentry: boolean;
  created_by: string | null;
}

export interface EnrollmentRow {
  id: string;
  journey_id: string;
  account_id: string;
  contact_id: string;
  status: 'active' | 'waiting' | 'completed' | 'exited' | 'failed';
  current_node_id: string | null;
  wait_kind: 'timer' | 'reply' | null;
  next_run_at: string | null;
  steps_taken: number;
  context: Record<string, unknown>;
  entered_at: string;
}

export interface SendContext {
  accountId: string;
  userId: string;
  contactId: string;
  conversationId: string;
}

export interface JourneyDeps {
  now(): Date;
  sendTemplate(ctx: SendContext, cfg: NodeConfigs['send_template']): Promise<void>;
  sendText(ctx: SendContext, text: string): Promise<void>;
  addTag(ctx: Omit<SendContext, 'conversationId'>, tagId: string): Promise<void>;
}

/** Steps executed in one advance before we assume a runaway graph. */
export const MAX_STEPS_PER_ADVANCE = 50;

// ------------------------------------------------------------------
// Small DB helpers
// ------------------------------------------------------------------

async function logEvent(
  db: SupabaseClient,
  e: Pick<EnrollmentRow, 'id' | 'journey_id'>,
  nodeId: string,
  event: string,
  detail?: string
) {
  await db.from('journey_events').insert({
    journey_id: e.journey_id,
    enrollment_id: e.id,
    node_id: nodeId,
    event,
    detail: detail ?? null,
  });
}

async function patchEnrollment(db: SupabaseClient, id: string, patch: Record<string, unknown>) {
  const { error } = await db.from('journey_enrollments').update(patch).eq('id', id);
  if (error) throw new Error(`enrollment update failed: ${error.message}`);
}

/** The contact's conversation, created when they have none yet. */
export async function ensureConversation(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  userId: string | null
): Promise<string> {
  const { data } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (data?.id) return data.id as string;

  const { data: owner } = await db
    .from('whatsapp_config')
    .select('user_id')
    .eq('account_id', accountId)
    .maybeSingle();
  const { data: created, error } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      contact_id: contactId,
      user_id: userId ?? owner?.user_id,
      status: 'open',
    })
    .select('id')
    .single();
  if (error || !created) throw new Error(`could not create conversation: ${error?.message ?? 'unknown'}`);
  return created.id as string;
}

export function interpolate(text: string, contact: { name?: string | null; phone?: string | null }): string {
  return text
    .replace(/\{\{\s*name\s*\}\}/gi, contact.name?.trim() || '')
    .replace(/\{\{\s*phone\s*\}\}/gi, contact.phone?.trim() || '');
}

// ------------------------------------------------------------------
// Conditions
// ------------------------------------------------------------------

async function evaluateCondition(
  db: SupabaseClient,
  e: EnrollmentRow,
  cfg: NodeConfigs['condition'],
  now: Date
): Promise<boolean> {
  const since = (e.context.wait_started_at as string | undefined) ?? e.entered_at;
  switch (cfg.kind) {
    case 'has_tag': {
      const { count } = await db
        .from('contact_tags')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', e.contact_id)
        .eq('tag_id', cfg.tag_id ?? '');
      return (count ?? 0) > 0;
    }
    case 'clicked_button': {
      let q = db
        .from('button_clicks')
        .select('id, button_text, button_payload')
        .eq('account_id', e.account_id)
        .eq('contact_id', e.contact_id)
        .gte('clicked_at', e.entered_at);
      q = q.limit(50);
      const { data } = await q;
      const want = cfg.button_text?.trim().toLowerCase();
      return (data ?? []).some(
        (c) =>
          !want ||
          String(c.button_text ?? '').trim().toLowerCase() === want ||
          String(c.button_payload ?? '').trim().toLowerCase() === want
      );
    }
    case 'replied': {
      const { data: conv } = await db
        .from('conversations')
        .select('id')
        .eq('account_id', e.account_id)
        .eq('contact_id', e.contact_id)
        .maybeSingle();
      if (!conv) return false;
      const { count } = await db
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', conv.id)
        .eq('sender_type', 'customer')
        .gte('created_at', since);
      return (count ?? 0) > 0;
    }
    case 'window_open': {
      const { data: conv } = await db
        .from('conversations')
        .select('last_customer_message_at')
        .eq('account_id', e.account_id)
        .eq('contact_id', e.contact_id)
        .maybeSingle();
      const last = conv?.last_customer_message_at ? new Date(conv.last_customer_message_at).getTime() : 0;
      return now.getTime() - last < 24 * 3600_000;
    }
  }
}

// ------------------------------------------------------------------
// Advance
// ------------------------------------------------------------------

export type AdvanceOutcome = 'waiting' | 'completed' | 'failed' | 'exited';

/**
 * Run an enrollment from its current node. `resumeSlot` leaves a wait
 * through that slot first ('next' after a timer, 'replied' / 'timeout'
 * after a wait for reply); without it the current node is (re)run.
 */
export async function advanceEnrollment(
  db: SupabaseClient,
  journey: JourneyRow,
  enrollment: EnrollmentRow,
  deps: JourneyDeps,
  resumeSlot?: string
): Promise<AdvanceOutcome> {
  const byId = new Map(journey.graph.nodes.map((n) => [n.id, n]));
  const e = enrollment;
  let node: JourneyNode | undefined = e.current_node_id
    ? byId.get(e.current_node_id)
    : (findTrigger(journey.graph) ?? undefined);
  let steps = e.steps_taken;
  let context = { ...e.context };

  const fail = async (nodeId: string, message: string): Promise<AdvanceOutcome> => {
    await logEvent(db, e, nodeId, 'failed', message);
    await patchEnrollment(db, e.id, {
      status: 'failed',
      last_error: message.slice(0, 1000),
      locked_at: null,
      wait_kind: null,
      completed_at: deps.now().toISOString(),
    });
    return 'failed';
  };

  if (journey.status !== 'active') {
    await patchEnrollment(db, e.id, { status: 'exited', locked_at: null, wait_kind: null, completed_at: deps.now().toISOString() });
    return 'exited';
  }
  if (!node) return fail(e.current_node_id ?? 'unknown', 'The step this contact was on no longer exists');

  // Leave the wait we're resuming from.
  if (resumeSlot) {
    const target: string | undefined = node.next?.[resumeSlot];
    await logEvent(db, e, node.id, `exit:${resumeSlot}`);
    if (!target || !byId.has(target)) return fail(node.id, `"${resumeSlot}" is not connected`);
    node = byId.get(target)!;
  }

  const sendCtx = async (): Promise<SendContext> => ({
    accountId: e.account_id,
    userId: journey.created_by ?? '',
    contactId: e.contact_id,
    conversationId: await ensureConversation(db, e.account_id, e.contact_id, journey.created_by),
  });

  for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i++) {
    const now = deps.now();
    steps += 1;
    await logEvent(db, e, node.id, 'entered');
    await patchEnrollment(db, e.id, { current_node_id: node.id, steps_taken: steps });

    let slot: string;
    try {
      slot = await runNode(db, journey, e, node, deps, now, sendCtx, (patch) => {
        context = { ...context, ...patch };
      });
    } catch (err) {
      return fail(node.id, err instanceof Error ? err.message : String(err));
    }

    if (slot === '__wait') return 'waiting';
    if (slot === '__end') {
      await patchEnrollment(db, e.id, {
        status: 'completed',
        locked_at: null,
        wait_kind: null,
        completed_at: now.toISOString(),
      });
      return 'completed';
    }

    await logEvent(db, e, node.id, `exit:${slot}`);
    const target: string | undefined = node.next?.[slot];
    if (!target || !byId.has(target)) return fail(node.id, `"${slot}" is not connected`);
    node = byId.get(target)!;
  }
  return fail(node.id, `Stopped after ${MAX_STEPS_PER_ADVANCE} steps without a wait`);
}

/** Execute one node; returns the slot to leave by, '__wait' or '__end'. */
async function runNode(
  db: SupabaseClient,
  journey: JourneyRow,
  e: EnrollmentRow,
  node: JourneyNode,
  deps: JourneyDeps,
  now: Date,
  sendCtx: () => Promise<SendContext>,
  setContext: (patch: Record<string, unknown>) => void
): Promise<string> {
  switch (node.type) {
    case 'trigger':
      return 'next';

    case 'wait':
    case 'wait_for_reply': {
      const cfg = node.config as NodeConfigs['wait'];
      const until = new Date(now.getTime() + durationMs(cfg.amount, cfg.unit));
      const context = { ...e.context, wait_started_at: now.toISOString() };
      setContext(context);
      await patchEnrollment(db, e.id, {
        status: 'waiting',
        wait_kind: node.type === 'wait' ? 'timer' : 'reply',
        next_run_at: until.toISOString(),
        locked_at: null,
        context,
      });
      return '__wait';
    }

    case 'condition':
      return (await evaluateCondition(db, e, node.config as NodeConfigs['condition'], now)) ? 'yes' : 'no';

    case 'send_template': {
      const cfg = node.config as NodeConfigs['send_template'];
      const contact = await loadContact(db, e);
      await deps.sendTemplate(await sendCtx(), {
        ...cfg,
        params: (cfg.params ?? []).map((p) => interpolate(p, contact)),
      });
      return 'next';
    }

    case 'send_text': {
      const cfg = node.config as NodeConfigs['send_text'];
      const contact = await loadContact(db, e);
      const open = await evaluateCondition(db, e, { kind: 'window_open' }, now);
      if (!open) {
        throw new Error(
          'Text messages can only be sent within 24 hours of the customer’s last message — use a template here'
        );
      }
      await deps.sendText(await sendCtx(), interpolate(cfg.text, contact));
      return 'next';
    }

    case 'add_tag': {
      const cfg = node.config as NodeConfigs['add_tag'];
      await deps.addTag({ accountId: e.account_id, userId: journey.created_by ?? '', contactId: e.contact_id }, cfg.tag_id);
      return 'next';
    }

    case 'remove_tag': {
      const cfg = node.config as NodeConfigs['remove_tag'];
      await db.from('contact_tags').delete().eq('contact_id', e.contact_id).eq('tag_id', cfg.tag_id);
      return 'next';
    }

    case 'create_deal': {
      const cfg = node.config as NodeConfigs['create_deal'];
      const contact = await loadContact(db, e);
      const { data: acct } = await db
        .from('accounts')
        .select('default_currency')
        .eq('id', e.account_id)
        .maybeSingle();
      const { error } = await db.from('deals').insert({
        account_id: e.account_id,
        user_id: journey.created_by,
        pipeline_id: cfg.pipeline_id,
        stage_id: cfg.stage_id,
        contact_id: e.contact_id,
        title: interpolate(cfg.title || 'Deal', contact) || 'Deal',
        value: Number(cfg.value) || 0,
        currency: acct?.default_currency ?? 'USD',
        status: 'open',
      });
      if (error) throw new Error(`could not create deal: ${error.message}`);
      return 'next';
    }

    case 'end':
      return '__end';
  }
  // Exhaustiveness: an unknown type can only come from a hand-edited graph.
  void slotsFor;
  throw new Error(`Unknown step type ${(node as { type: string }).type}`);
}

async function loadContact(db: SupabaseClient, e: EnrollmentRow) {
  const { data } = await db
    .from('contacts')
    .select('name, phone')
    .eq('id', e.contact_id)
    .eq('account_id', e.account_id)
    .maybeSingle();
  return (data ?? {}) as { name?: string | null; phone?: string | null };
}

// ------------------------------------------------------------------
// Entry points
// ------------------------------------------------------------------

export async function enrollContact(
  db: SupabaseClient,
  journey: JourneyRow,
  contactId: string,
  deps: JourneyDeps,
  context: Record<string, unknown> = {}
): Promise<{ enrolled: boolean; outcome?: AdvanceOutcome; reason?: string }> {
  if (journey.status !== 'active') return { enrolled: false, reason: 'journey_not_active' };
  const trigger = findTrigger(journey.graph);
  if (!trigger) return { enrolled: false, reason: 'no_trigger' };

  if (!journey.allow_reentry) {
    const { count } = await db
      .from('journey_enrollments')
      .select('id', { count: 'exact', head: true })
      .eq('journey_id', journey.id)
      .eq('contact_id', contactId);
    if ((count ?? 0) > 0) return { enrolled: false, reason: 'already_enrolled' };
  }

  const now = deps.now();
  const { data, error } = await db
    .from('journey_enrollments')
    .insert({
      journey_id: journey.id,
      account_id: journey.account_id,
      contact_id: contactId,
      status: 'active',
      current_node_id: trigger.id,
      locked_at: now.toISOString(),
      context,
      entered_at: now.toISOString(),
    })
    .select('*')
    .single();
  if (error || !data) {
    // 23505: a live enrollment already exists (unique index) — fine.
    return { enrolled: false, reason: error?.code === '23505' ? 'already_live' : error?.message ?? 'insert_failed' };
  }
  const outcome = await advanceEnrollment(db, journey, data as EnrollmentRow, deps);
  return { enrolled: true, outcome };
}

async function loadJourney(db: SupabaseClient, id: string): Promise<JourneyRow | null> {
  const { data } = await db.from('journeys').select('*').eq('id', id).maybeSingle();
  return (data as JourneyRow | null) ?? null;
}

/** A customer message arrived: resume their "wait for reply" steps. */
export async function resumeOnReply(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  deps: JourneyDeps
): Promise<number> {
  const { data: waiting } = await db
    .from('journey_enrollments')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'waiting')
    .eq('wait_kind', 'reply');

  let resumed = 0;
  for (const row of (waiting ?? []) as EnrollmentRow[]) {
    // Claim atomically — the tick may be timing this one out right now.
    const { data: claimed } = await db
      .from('journey_enrollments')
      .update({ status: 'active', locked_at: deps.now().toISOString(), wait_kind: null })
      .eq('id', row.id)
      .eq('status', 'waiting')
      .eq('wait_kind', 'reply')
      .select('id');
    if (!claimed?.length) continue;
    const journey = await loadJourney(db, row.journey_id);
    if (!journey) continue;
    await advanceEnrollment(db, journey, { ...row, status: 'active', wait_kind: null }, deps, 'replied');
    resumed++;
  }
  return resumed;
}

export interface TickReport {
  claimed: number;
  outcomes: Record<AdvanceOutcome, number>;
  errors: string[];
}

/** Advance due timers, reply timeouts and crashed steps. */
export async function runJourneyTick(db: SupabaseClient, deps: JourneyDeps): Promise<TickReport> {
  const report: TickReport = {
    claimed: 0,
    outcomes: { waiting: 0, completed: 0, failed: 0, exited: 0 },
    errors: [],
  };
  const { data, error } = await db.rpc('claim_journey_enrollments', { p_limit: 200 });
  if (error) throw new Error(`claim_journey_enrollments failed: ${error.message}`);

  const journeys = new Map<string, JourneyRow | null>();
  for (const row of (data ?? []) as EnrollmentRow[]) {
    report.claimed++;
    try {
      if (!journeys.has(row.journey_id)) journeys.set(row.journey_id, await loadJourney(db, row.journey_id));
      const journey = journeys.get(row.journey_id);
      if (!journey) continue;
      // Timer elapsed → 'next'; reply never came → 'timeout';
      // wait_kind cleared = a step crashed mid-run → re-run it.
      const slot = row.wait_kind === 'timer' ? 'next' : row.wait_kind === 'reply' ? 'timeout' : undefined;
      await patchEnrollment(db, row.id, { wait_kind: null });
      const outcome = await advanceEnrollment(db, journey, { ...row, wait_kind: null }, deps, slot);
      report.outcomes[outcome]++;
    } catch (err) {
      report.errors.push(`${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return report;
}
