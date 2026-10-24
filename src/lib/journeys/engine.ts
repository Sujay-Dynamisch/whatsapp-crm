// ============================================================
// Journey engine (migrations 050, 054).
//
// Moves one enrollment through the graph until it reaches a wait, an
// end, or a failure. Every node entered and every slot taken is logged
// to journey_events (the canvas conversion numbers); since 054 each
// exit also carries the step's output, which is the run history.
//
// Data flows n8n-style: every step's output is stored on the
// enrollment context (`nodes.<id>`), and text fields reference it with
// {{ … }} expressions (./expressions). Context survives waits.
//
//   enrollContact()   start a contact at the trigger
//   resumeOnReply()   a waiting "wait for reply" got its reply
//   runJourneyTick()  timers / reply timeouts / crashed steps /
//                     due schedules (Cloud Scheduler, once a minute)
//
// Side effects go through `JourneyDeps` so tests drive the whole engine
// against an in-memory database without Meta.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  durationMs,
  findTrigger,
  MAX_LOOP_ITEMS,
  slotsFor,
  type JourneyGraph,
  type JourneyNode,
  type JourneyTriggerType,
  type NodeConfigs,
  type TriggerConfig,
} from './graph';
import { compare, evaluateValue, renderTemplate, type ExprScope } from './expressions';
import { HttpStepError, runHttpRequest, type HttpFetch } from './http';
import type { CodeResult } from './sandbox';
import {
  DEFAULT_RETRY_WINDOW_MS,
  recordJourneyMessage,
  runJourneyRetries,
  type JourneyMessageKind,
  type RecordInput,
  type RetryReport,
  type SendResult,
} from './messages';
import { isUnsubscribeText } from '@/lib/contacts/unsubscribe';
import { resolveTemplateRow, templateContentText } from '@/lib/whatsapp/template-body';

export interface JourneyRow {
  id: string;
  account_id: string;
  status: 'draft' | 'active' | 'paused';
  trigger_type: JourneyTriggerType;
  trigger_config: Partial<TriggerConfig> | null;
  graph: JourneyGraph;
  allow_reentry: boolean;
  created_by: string | null;
  webhook_token?: string | null;
  next_scheduled_at?: string | null;
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
  // Senders return the Meta message id (and the text sent) when they can,
  // so the run's message log can follow delivery (journey_messages).
  sendTemplate(ctx: SendContext, cfg: NodeConfigs['send_template']): Promise<SendResult | void>;
  sendText(ctx: SendContext, text: string): Promise<SendResult | void>;
  addTag(ctx: Omit<SendContext, 'conversationId'>, tagId: string): Promise<void>;
  sendMedia?(ctx: SendContext, cfg: NodeConfigs['send_media']): Promise<SendResult | void>;
  sendButtons?(
    ctx: SendContext,
    cfg: { text: string; header?: string; footer?: string; buttons: { id: string; title: string }[] }
  ): Promise<SendResult | void>;
  /** HTTP step transport + destination check (tests stub these). */
  http?: HttpFetch;
  checkUrl?: (url: string) => Promise<boolean>;
  /** Code step runner (defaults to the QuickJS sandbox). */
  runCode?: (code: string, input: Record<string, unknown>) => Promise<CodeResult>;
}

/**
 * Steps executed in one advance before we assume a runaway graph.
 * High enough for a loop over MAX_LOOP_ITEMS items with a few steps in
 * its body; a cycle without a wait or loop is rejected on save anyway.
 */
export const MAX_STEPS_PER_ADVANCE = 500;
/** One step's output kept on the context / event log. */
const MAX_OUTPUT_CHARS = 64 * 1024;
/** The whole run context (all outputs + variables). */
const MAX_CONTEXT_CHARS = 1024 * 1024;

// ------------------------------------------------------------------
// Run context
// ------------------------------------------------------------------

interface LoopState {
  items: unknown[];
  index: number;
}

/** What an enrollment carries between steps (journey_enrollments.context). */
interface RunContext extends Record<string, unknown> {
  /** Legacy (050) trigger keys. */
  trigger?: string;
  tag_id?: string;
  button_text?: string;
  /** What started the run — webhook body, inbound message, … */
  trigger_data?: Record<string, unknown>;
  nodes?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  reply?: { text?: string; button?: string; at?: string } | null;
  loops?: Record<string, LoopState>;
  loop_stack?: string[];
  wait_started_at?: string;
}

function capOutput(value: unknown): unknown {
  if (value === undefined) return null;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { _unserialisable: true };
  }
  if (json === undefined) return null;
  if (json.length <= MAX_OUTPUT_CHARS) return value;
  return { _truncated: true, size: json.length, preview: json.slice(0, 2000) };
}

function triggerScope(ctx: RunContext): Record<string, unknown> {
  if (ctx.trigger_data && typeof ctx.trigger_data === 'object') return ctx.trigger_data;
  const legacy: Record<string, unknown> = { type: ctx.trigger ?? 'manual' };
  if (ctx.tag_id) legacy.tag_id = ctx.tag_id;
  if (ctx.button_text) legacy.button_text = ctx.button_text;
  return legacy;
}

/** The expression scope a step sees, from a run's context. */
export function scopeFromContext(
  ctx: Record<string, unknown>,
  contact: Record<string, unknown>,
  now: Date
): ExprScope {
  const context = ctx as RunContext;
  const stack = context.loop_stack ?? [];
  const top = stack.length ? context.loops?.[stack[stack.length - 1]] : undefined;
  const idx = top ? top.index - 1 : null;
  return {
    contact,
    trigger: triggerScope(context),
    nodes: context.nodes ?? {},
    vars: context.vars ?? {},
    reply: context.reply ?? null,
    item: top && idx !== null ? top.items[idx] : null,
    index: idx,
    now: now.toISOString(),
  };
}

// ------------------------------------------------------------------
// Small DB helpers
// ------------------------------------------------------------------

async function logEvent(
  db: SupabaseClient,
  e: Pick<EnrollmentRow, 'id' | 'journey_id'>,
  nodeId: string,
  event: string,
  detail?: string,
  data?: unknown
) {
  await db.from('journey_events').insert({
    journey_id: e.journey_id,
    enrollment_id: e.id,
    node_id: nodeId,
    event,
    detail: detail ?? null,
    ...(data !== undefined ? { data: capOutput(data) } : {}),
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

/** Legacy helper: {{name}} / {{phone}} only. Kept for callers outside the engine. */
export function interpolate(text: string, contact: { name?: string | null; phone?: string | null }): string {
  return text
    .replace(/\{\{\s*name\s*\}\}/gi, contact.name?.trim() || '')
    .replace(/\{\{\s*phone\s*\}\}/gi, contact.phone?.trim() || '');
}

export async function loadContact(
  db: SupabaseClient,
  e: Pick<EnrollmentRow, 'contact_id' | 'account_id'>
): Promise<Record<string, unknown>> {
  const { data } = await db
    .from('contacts')
    .select('*')
    .eq('id', e.contact_id)
    .eq('account_id', e.account_id)
    .maybeSingle();
  const contact: Record<string, unknown> = { ...(data ?? {}) };

  // Custom fields by name: {{ contact.custom.city }}.
  const { data: values } = await db
    .from('contact_custom_values')
    .select('value, custom_fields(field_name)')
    .eq('contact_id', e.contact_id);
  const custom: Record<string, unknown> = {};
  for (const row of (values ?? []) as { value: unknown; custom_fields?: { field_name?: string } | { field_name?: string }[] }[]) {
    const def = Array.isArray(row.custom_fields) ? row.custom_fields[0] : row.custom_fields;
    if (def?.field_name) custom[def.field_name] = row.value;
  }
  contact.custom = custom;
  return contact;
}

// ------------------------------------------------------------------
// Built-in conditions
// ------------------------------------------------------------------

async function evaluateCondition(
  db: SupabaseClient,
  e: EnrollmentRow,
  cfg: NodeConfigs['condition'],
  now: Date,
  context: RunContext,
  scope: () => Promise<ExprScope>
): Promise<boolean> {
  const since = context.wait_started_at ?? e.entered_at;
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
      const { data } = await db
        .from('button_clicks')
        .select('id, button_text, button_payload')
        .eq('account_id', e.account_id)
        .eq('contact_id', e.contact_id)
        .gte('clicked_at', e.entered_at)
        .limit(50);
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
    case 'window_open':
      return windowOpen(db, e, now);
    case 'expression': {
      const s = await scope();
      return compare(cfg.op ?? 'equals', evaluateValue(cfg.left ?? '', s), evaluateValue(cfg.right ?? '', s));
    }
  }
  return false;
}

async function windowOpen(db: SupabaseClient, e: EnrollmentRow, now: Date): Promise<boolean> {
  const { data: conv } = await db
    .from('conversations')
    .select('last_customer_message_at')
    .eq('account_id', e.account_id)
    .eq('contact_id', e.contact_id)
    .maybeSingle();
  const last = conv?.last_customer_message_at ? new Date(conv.last_customer_message_at).getTime() : 0;
  return now.getTime() - last < 24 * 3600_000;
}

const WINDOW_CLOSED =
  'Free-form messages can only be sent within 24 hours of the customer’s last message — use a template here';

// ------------------------------------------------------------------
// Advance
// ------------------------------------------------------------------

export type AdvanceOutcome = 'waiting' | 'completed' | 'failed' | 'exited';

interface StepResult {
  /** Slot to leave by, or '__wait' / '__end'. */
  slot: string;
  /** Stored as nodes.<id> and logged on the exit event. */
  output?: unknown;
}

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
  const context: RunContext = { ...(e.context as RunContext) };
  let contact: Record<string, unknown> | null = null;

  const fail = async (nodeId: string, message: string, data?: unknown): Promise<AdvanceOutcome> => {
    await logEvent(db, e, nodeId, 'failed', message, data);
    await patchEnrollment(db, e.id, {
      status: 'failed',
      last_error: message.slice(0, 1000),
      locked_at: null,
      wait_kind: null,
      context,
      completed_at: deps.now().toISOString(),
    });
    return 'failed';
  };

  if (journey.status !== 'active') {
    await patchEnrollment(db, e.id, { status: 'exited', locked_at: null, wait_kind: null, completed_at: deps.now().toISOString() });
    return 'exited';
  }
  // Global stops: the contact opted out (STOP / 'unsubscribe' tag) or got
  // one of the journey's exit tags (e.g. paid / closed) — no more steps.
  const stop = await stopReason(db, journey, e, resumeSlot === 'replied' ? context.reply?.text : null);
  if (stop) {
    await logEvent(db, e, node?.id ?? e.current_node_id ?? 'trigger', 'exited', stop);
    await patchEnrollment(db, e.id, {
      status: 'exited',
      locked_at: null,
      wait_kind: null,
      last_error: stop,
      context,
      completed_at: deps.now().toISOString(),
    });
    return 'exited';
  }
  if (!node) return fail(e.current_node_id ?? 'unknown', 'The step this contact was on no longer exists');

  // Leave the wait we're resuming from.
  if (resumeSlot) {
    const target: string | undefined = node.next?.[resumeSlot];
    await logEvent(db, e, node.id, `exit:${resumeSlot}`, undefined, resumeSlot === 'replied' ? context.reply ?? null : undefined);
    if (!target || !byId.has(target)) return fail(node.id, `"${resumeSlot}" is not connected`);
    node = byId.get(target)!;
  }

  const sendCtx = async (): Promise<SendContext> => ({
    accountId: e.account_id,
    userId: journey.created_by ?? '',
    contactId: e.contact_id,
    conversationId: await ensureConversation(db, e.account_id, e.contact_id, journey.created_by),
  });

  const scope = async (): Promise<ExprScope> => {
    contact ??= await loadContact(db, e);
    return scopeFromContext(context, contact, deps.now());
  };

  const rt: Runtime = {
    db,
    journey,
    e,
    deps,
    context,
    sendCtx,
    scope,
    invalidateContact: () => {
      contact = null;
    },
    record: async (nodeId, input) => {
      await recordJourneyMessage(
        db,
        { ...input, account_id: e.account_id, journey_id: e.journey_id, enrollment_id: e.id, contact_id: e.contact_id, node_id: nodeId },
        deps.now()
      );
    },
  };

  for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i++) {
    const now = deps.now();
    steps += 1;
    await logEvent(db, e, node.id, 'entered');
    await patchEnrollment(db, e.id, { current_node_id: node.id, steps_taken: steps });

    let result: StepResult;
    try {
      result = await runNode(rt, node, now);
    } catch (err) {
      return fail(node.id, err instanceof Error ? err.message : String(err), err instanceof StepError ? err.data : undefined);
    }

    if (result.output !== undefined) {
      context.nodes = { ...(context.nodes ?? {}), [node.id]: capOutput(result.output) };
      if (JSON.stringify(context).length > MAX_CONTEXT_CHARS) {
        return fail(node.id, 'This run is carrying more than 1 MB of data — return less from your steps');
      }
    }

    if (result.slot === '__wait') return 'waiting';
    if (result.slot === '__end') {
      await patchEnrollment(db, e.id, {
        status: 'completed',
        locked_at: null,
        wait_kind: null,
        context,
        completed_at: now.toISOString(),
      });
      return 'completed';
    }

    await logEvent(db, e, node.id, `exit:${result.slot}`, undefined, result.output);
    const target: string | undefined = node.next?.[result.slot];
    if (!target || !byId.has(target)) return fail(node.id, `"${result.slot}" is not connected`);
    node = byId.get(target)!;
  }
  return fail(node.id, `Stopped after ${MAX_STEPS_PER_ADVANCE} steps without a wait`);
}

interface Runtime {
  db: SupabaseClient;
  journey: JourneyRow;
  e: EnrollmentRow;
  deps: JourneyDeps;
  context: RunContext;
  sendCtx: () => Promise<SendContext>;
  scope: () => Promise<ExprScope>;
  invalidateContact: () => void;
  /** Log a sent / failed message of this run (journey_messages). */
  record: (nodeId: string, input: Omit<RecordInput, 'account_id' | 'journey_id' | 'enrollment_id' | 'contact_id' | 'node_id'>) => Promise<void>;
}

/** Why this run must stop before its next step, or null. Never throws. */
async function stopReason(
  db: SupabaseClient,
  journey: JourneyRow,
  e: EnrollmentRow,
  replyText: string | null | undefined
): Promise<string | null> {
  if (isUnsubscribeText(replyText)) return 'Contact opted out (STOP)';
  try {
    const exitIds = (findTrigger(journey.graph)?.config as TriggerConfig | undefined)?.exit_tag_ids ?? [];
    const { data } = await db.from('contact_tags').select('tag_id, tags(name)').eq('contact_id', e.contact_id);
    for (const row of (data ?? []) as { tag_id: string; tags?: { name?: string } | { name?: string }[] | null }[]) {
      const tag = Array.isArray(row.tags) ? row.tags[0] : row.tags;
      const name = tag?.name?.trim() ?? '';
      if (name.toLowerCase() === 'unsubscribe') return 'Contact opted out (unsubscribe tag)';
      if (exitIds.includes(row.tag_id)) return `Stopped: contact has the "${name || row.tag_id}" tag`;
    }
  } catch {
    // A failed lookup must not stop a healthy run.
  }
  return null;
}

/** Until when a template step may be retried / re-sent as text (ISO). */
function retryUntil(expr: string | undefined, scope: ExprScope, now: Date): string {
  if (expr?.trim()) {
    const raw = evaluateValue(expr, scope);
    const at = new Date(raw instanceof Date ? raw.getTime() : String(raw ?? ''));
    if (!Number.isNaN(at.getTime())) return at.toISOString();
  }
  return new Date(now.getTime() + DEFAULT_RETRY_WINDOW_MS).toISOString();
}

/** Run a free-form send and log it (failed sends are logged, then rethrown). */
async function trackSend(
  rt: Runtime,
  nodeId: string,
  kind: JourneyMessageKind,
  content: string | null,
  send: () => Promise<SendResult | void>
): Promise<SendResult> {
  try {
    const sent = (await send()) || {};
    await rt.record(nodeId, { kind, content_text: sent.content_text ?? content, wa_message_id: sent.whatsapp_message_id ?? null, status: 'sent' });
    return sent;
  } catch (err) {
    await rt.record(nodeId, { kind, content_text: content, status: 'failed', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** A step failure that carries data for the run history. */
class StepError extends Error {
  constructor(
    message: string,
    readonly data?: unknown
  ) {
    super(message);
  }
}

/** Route a step error to its "error" output when connected, else fail. */
function errorSlot(node: JourneyNode, message: string, data: unknown): StepResult {
  if (node.next?.error) return { slot: 'error', output: { error: message, ...(data && typeof data === 'object' ? data : {}) } };
  throw new StepError(message, data);
}

/** Execute one node. */
async function runNode(rt: Runtime, node: JourneyNode, now: Date): Promise<StepResult> {
  const { db, journey, e, deps, context } = rt;
  switch (node.type) {
    case 'trigger':
      return { slot: 'next', output: triggerScope(context) };

    case 'wait':
    case 'wait_for_reply': {
      const cfg = node.config as NodeConfigs['wait'];
      let until = new Date(now.getTime() + durationMs(cfg.amount, cfg.unit));
      // "Wait until": resume at a computed time (past = next tick), capped at 90 days.
      if (node.type === 'wait' && cfg.until?.trim()) {
        const raw = evaluateValue(cfg.until, await rt.scope());
        const at = new Date(raw instanceof Date ? raw.getTime() : String(raw ?? ''));
        if (!Number.isNaN(at.getTime())) {
          until = new Date(Math.min(at.getTime(), now.getTime() + durationMs(90, 'days')));
        }
      }
      context.wait_started_at = now.toISOString();
      await patchEnrollment(db, e.id, {
        status: 'waiting',
        wait_kind: node.type === 'wait' ? 'timer' : 'reply',
        next_run_at: until.toISOString(),
        locked_at: null,
        context,
      });
      return { slot: '__wait' };
    }

    case 'condition': {
      const cfg = node.config as NodeConfigs['condition'];
      const yes = await evaluateCondition(db, e, cfg, now, context, rt.scope);
      return { slot: yes ? 'yes' : 'no', output: cfg.kind === 'expression' ? { result: yes } : undefined };
    }

    case 'switch': {
      const cfg = node.config as NodeConfigs['switch'];
      const s = await rt.scope();
      const value = evaluateValue(cfg.value, s);
      const i = (cfg.cases ?? []).findIndex((k) => compare(k.op, value, evaluateValue(k.value ?? '', s)));
      return { slot: i >= 0 ? `case_${i}` : 'default', output: { value, matched: i >= 0 ? i : null } };
    }

    case 'loop': {
      const cfg = node.config as NodeConfigs['loop'];
      const loops = { ...(context.loops ?? {}) };
      let state = loops[node.id];
      if (!state) {
        const raw = evaluateValue(cfg.items, await rt.scope());
        const list = Array.isArray(raw) ? raw : raw === null || raw === undefined || raw === '' ? [] : [raw];
        const max = Math.min(MAX_LOOP_ITEMS, Math.max(1, Number(cfg.max) || MAX_LOOP_ITEMS));
        state = { items: list.slice(0, max), index: 0 };
        context.loop_stack = [...(context.loop_stack ?? []), node.id];
      }
      if (state.index < state.items.length) {
        const item = state.items[state.index];
        loops[node.id] = { ...state, index: state.index + 1 };
        context.loops = loops;
        return { slot: 'each', output: { item, index: state.index, total: state.items.length } };
      }
      delete loops[node.id];
      context.loops = loops;
      context.loop_stack = (context.loop_stack ?? []).filter((id) => id !== node.id);
      return { slot: 'done', output: { count: state.items.length } };
    }

    case 'set_variable': {
      const cfg = node.config as NodeConfigs['set_variable'];
      const s = await rt.scope();
      const assigned: Record<string, unknown> = {};
      for (const a of cfg.assignments ?? []) {
        if (!a.key) continue;
        assigned[a.key] = evaluateValue(a.value ?? '', s);
        // Later assignments in the same step can use earlier ones.
        s.vars = { ...s.vars, [a.key]: assigned[a.key] };
      }
      context.vars = { ...(context.vars ?? {}), ...assigned };
      return { slot: 'next', output: assigned };
    }

    case 'http_request': {
      const cfg = node.config as NodeConfigs['http_request'];
      try {
        const output = await runHttpRequest(cfg, await rt.scope(), deps.http, deps.checkUrl);
        return { slot: 'success', output };
      } catch (err) {
        if (err instanceof HttpStepError) return errorSlot(node, err.message, err.output);
        throw err;
      }
    }

    case 'code': {
      const cfg = node.config as NodeConfigs['code'];
      const s = await rt.scope();
      const run = deps.runCode ?? (async (code, input) => (await import('./sandbox')).runUserCode(code, input));
      try {
        const { result, logs } = await run(cfg.code, { ...s } as unknown as Record<string, unknown>);
        if (logs.length) await logEvent(db, e, node.id, 'log', logs.join('\n').slice(0, 4000));
        return { slot: 'success', output: result };
      } catch (err) {
        return errorSlot(node, err instanceof Error ? err.message : String(err), null);
      }
    }

    case 'send_template': {
      const cfg = node.config as NodeConfigs['send_template'];
      const s = await rt.scope();
      const params = (cfg.params ?? []).map((p) => renderTemplate(p, s));
      const logged = {
        kind: 'template' as const,
        template_name: cfg.template_name,
        language: cfg.language ?? null,
        params,
        retry_until: retryUntil(cfg.retry_until, s, now),
      };
      try {
        const sent = (await deps.sendTemplate(await rt.sendCtx(), { ...cfg, params })) || {};
        await rt.record(node.id, { ...logged, content_text: sent.content_text ?? null, wa_message_id: sent.whatsapp_message_id ?? null, status: 'sent' });
        return { slot: 'next', output: { template: cfg.template_name, params, message_id: sent.whatsapp_message_id ?? null } };
      } catch (err) {
        // A template Meta refused doesn't end the run: it is logged (and
        // retried / re-sent as text later when possible) and the journey
        // carries on, so the contact still gets the next steps.
        const message = err instanceof Error ? err.message : String(err);
        let content: string | null = null;
        try {
          content = templateContentText((await resolveTemplateRow(db, e.account_id, cfg.template_name, cfg.language)).row, params);
        } catch {
          // body unavailable — no text fallback for this one
        }
        await rt.record(node.id, { ...logged, content_text: content, status: 'failed', error: message });
        if (node.next?.error) return { slot: 'error', output: { template: cfg.template_name, params, error: message } };
        await logEvent(db, e, node.id, 'send_failed', message.slice(0, 1000));
        return { slot: 'next', output: { template: cfg.template_name, params, error: message } };
      }
    }

    case 'send_text': {
      const cfg = node.config as NodeConfigs['send_text'];
      if (!(await windowOpen(db, e, now))) throw new Error(WINDOW_CLOSED);
      const text = renderTemplate(cfg.text, await rt.scope());
      if (!text.trim()) throw new Error('The message is empty after filling in the variables');
      const sendCtx = await rt.sendCtx();
      const sent = await trackSend(rt, node.id, 'text', text, () => deps.sendText(sendCtx, text));
      return { slot: 'next', output: { text, message_id: sent.whatsapp_message_id ?? null } };
    }

    case 'send_media': {
      const cfg = node.config as NodeConfigs['send_media'];
      if (!deps.sendMedia) throw new Error('Media sending is not available here');
      if (!(await windowOpen(db, e, now))) throw new Error(WINDOW_CLOSED);
      const s = await rt.scope();
      const url = renderTemplate(cfg.url, s).trim();
      if (!/^https:\/\//i.test(url)) throw new Error('The media URL must be a public https:// link');
      const sent = {
        media_type: cfg.media_type,
        url,
        caption: cfg.caption ? renderTemplate(cfg.caption, s) : undefined,
        filename: cfg.filename ? renderTemplate(cfg.filename, s) : undefined,
      };
      const mediaCtx = await rt.sendCtx();
      await trackSend(rt, node.id, 'media', sent.caption ?? `[${sent.media_type}] ${url}`, () => deps.sendMedia!(mediaCtx, sent));
      return { slot: 'next', output: sent };
    }

    case 'send_buttons': {
      const cfg = node.config as NodeConfigs['send_buttons'];
      if (!deps.sendButtons) throw new Error('Button messages are not available here');
      if (!(await windowOpen(db, e, now))) throw new Error(WINDOW_CLOSED);
      const s = await rt.scope();
      const buttons = (cfg.buttons ?? [])
        .map((b, i) => ({ id: `${node.id}:${i}`, title: renderTemplate(b.title, s).trim().slice(0, 20) }))
        .filter((b) => b.title);
      if (buttons.length === 0) throw new Error('No button has a title after filling in the variables');
      const text = renderTemplate(cfg.text, s);
      const buttonsCtx = await rt.sendCtx();
      await trackSend(rt, node.id, 'buttons', text, () =>
        deps.sendButtons!(buttonsCtx, {
          text,
          header: cfg.header ? renderTemplate(cfg.header, s) : undefined,
          footer: cfg.footer ? renderTemplate(cfg.footer, s) : undefined,
          buttons,
        })
      );
      return { slot: 'next', output: { text, buttons: buttons.map((b) => b.title) } };
    }

    case 'add_tag': {
      const cfg = node.config as NodeConfigs['add_tag'];
      await deps.addTag({ accountId: e.account_id, userId: journey.created_by ?? '', contactId: e.contact_id }, cfg.tag_id);
      return { slot: 'next' };
    }

    case 'remove_tag': {
      const cfg = node.config as NodeConfigs['remove_tag'];
      await db.from('contact_tags').delete().eq('contact_id', e.contact_id).eq('tag_id', cfg.tag_id);
      return { slot: 'next' };
    }

    case 'update_contact': {
      const cfg = node.config as NodeConfigs['update_contact'];
      const s = await rt.scope();
      const columns: Record<string, string> = {};
      const updated: Record<string, string> = {};
      for (const f of cfg.fields ?? []) {
        const value = renderTemplate(f.value ?? '', s);
        if (f.key === 'name' || f.key === 'email' || f.key === 'company') {
          columns[f.key] = value;
          updated[f.key] = value;
        } else if (f.key?.startsWith('custom:')) {
          const fieldId = f.key.slice('custom:'.length);
          // Service role bypasses RLS — confirm the field is this account's.
          const { data: field } = await db
            .from('custom_fields')
            .select('id, field_name')
            .eq('id', fieldId)
            .eq('account_id', e.account_id)
            .maybeSingle();
          if (!field) throw new Error('A custom field in this step no longer exists');
          const { error } = await db
            .from('contact_custom_values')
            .upsert({ contact_id: e.contact_id, custom_field_id: fieldId, value }, { onConflict: 'contact_id,custom_field_id' });
          if (error) throw new Error(`could not update ${field.field_name}: ${error.message}`);
          updated[String(field.field_name)] = value;
        }
      }
      if (Object.keys(columns).length) {
        const { error } = await db
          .from('contacts')
          .update({ ...columns, updated_at: new Date().toISOString() })
          .eq('id', e.contact_id)
          .eq('account_id', e.account_id);
        if (error) throw new Error(`could not update the contact: ${error.message}`);
      }
      rt.invalidateContact();
      return { slot: 'next', output: updated };
    }

    case 'conversation': {
      const cfg = node.config as NodeConfigs['conversation'];
      const conversationId = (await rt.sendCtx()).conversationId;
      let patch: Record<string, unknown>;
      if (cfg.action === 'assign') {
        const { data: member } = await db
          .from('profiles')
          .select('user_id')
          .eq('user_id', cfg.user_id ?? '')
          .eq('account_id', e.account_id)
          .maybeSingle();
        if (!member) throw new Error('The team member to assign is no longer in this account');
        patch = { assigned_agent_id: cfg.user_id };
      } else {
        patch = { status: cfg.action === 'close' ? 'closed' : 'open' };
      }
      const { error } = await db
        .from('conversations')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', conversationId)
        .eq('account_id', e.account_id);
      if (error) throw new Error(`could not update the conversation: ${error.message}`);
      return { slot: 'next', output: { action: cfg.action, ...(cfg.user_id ? { user_id: cfg.user_id } : {}) } };
    }

    case 'create_deal': {
      const cfg = node.config as NodeConfigs['create_deal'];
      const { data: acct } = await db
        .from('accounts')
        .select('default_currency')
        .eq('id', e.account_id)
        .maybeSingle();
      const title = renderTemplate(cfg.title || 'Deal', await rt.scope()) || 'Deal';
      const { data: deal, error } = await db
        .from('deals')
        .insert({
          account_id: e.account_id,
          user_id: journey.created_by,
          pipeline_id: cfg.pipeline_id,
          stage_id: cfg.stage_id,
          contact_id: e.contact_id,
          title,
          value: Number(cfg.value) || 0,
          currency: acct?.default_currency ?? 'USD',
          status: 'open',
        })
        .select('id')
        .maybeSingle();
      if (error) throw new Error(`could not create deal: ${error.message}`);
      return { slot: 'next', output: { deal_id: deal?.id ?? null, title } };
    }

    case 'end':
      return { slot: '__end' };
  }
  // Exhaustiveness: an unknown type can only come from a hand-edited graph.
  void slotsFor;
  throw new Error(`Unknown step type ${(node as { type: string }).type}`);
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

  // Scheduled and webhook runs repeat by design; the live-enrollment
  // unique index still keeps one run per contact at a time.
  const repeats = journey.allow_reentry || journey.trigger_type === 'schedule' || journey.trigger_type === 'webhook';
  if (!repeats) {
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
  deps: JourneyDeps,
  reply: { text?: string | null; button?: string | null } = {},
  /** Runs that just got an undelivered message re-sent as text — this reply isn't an answer to it. */
  skip: Set<string> = new Set()
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
    if (skip.has(row.id) && !isUnsubscribeText(reply.text)) continue;
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
    const context: RunContext = {
      ...(row.context as RunContext),
      reply: {
        text: reply.text ?? undefined,
        ...(reply.button ? { button: reply.button } : {}),
        at: deps.now().toISOString(),
      },
    };
    await advanceEnrollment(db, journey, { ...row, status: 'active', wait_kind: null, context }, deps, 'replied');
    resumed++;
  }
  return resumed;
}

export type StopOutcome = 'stopped' | 'not_found' | 'busy' | 'finished';

/**
 * Stop one contact's run by hand (run history → "Stop run"). Only a
 * waiting run is stopped, atomically, so it can't race the tick or a
 * reply; a run that is executing a step right now reports 'busy'.
 * Pending template retries of the run are dropped by the retry pass
 * (it skips exited runs).
 */
export async function stopEnrollment(
  db: SupabaseClient,
  args: { enrollmentId: string; journeyId: string; accountId: string; reason: string; now: Date }
): Promise<StopOutcome> {
  const { data: row } = await db
    .from('journey_enrollments')
    .select('id, journey_id, status, current_node_id')
    .eq('id', args.enrollmentId)
    .eq('journey_id', args.journeyId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (!row) return 'not_found';
  if (row.status === 'active') return 'busy';
  if (row.status !== 'waiting') return 'finished';

  const { data: claimed } = await db
    .from('journey_enrollments')
    .update({
      status: 'exited',
      wait_kind: null,
      locked_at: null,
      last_error: args.reason.slice(0, 1000),
      completed_at: args.now.toISOString(),
    })
    .eq('id', row.id)
    .eq('status', 'waiting')
    .select('id');
  if (!claimed?.length) return 'busy';
  await logEvent(db, { id: row.id as string, journey_id: row.journey_id as string }, (row.current_node_id as string) ?? 'trigger', 'exited', args.reason);
  return 'stopped';
}

export interface TickReport {
  claimed: number;
  outcomes: Record<AdvanceOutcome, number>;
  errors: string[];
  schedules?: { ran: number; enrolled: number };
  retries?: RetryReport;
}

/** Advance due timers, reply timeouts and crashed steps, then due schedules. */
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

  // Failed templates whose retry is due (journey_messages, migration 056).
  try {
    report.retries = await runJourneyRetries(db, deps.now(), async (row) => {
      const journey = journeys.get(row.journey_id) ?? (await loadJourney(db, row.journey_id));
      const ctx: SendContext = {
        accountId: row.account_id,
        userId: journey?.created_by ?? '',
        contactId: row.contact_id,
        conversationId: await ensureConversation(db, row.account_id, row.contact_id, journey?.created_by ?? null),
      };
      return deps.sendTemplate(ctx, {
        template_name: row.template_name ?? '',
        language: row.language ?? undefined,
        params: row.params ?? [],
      });
    });
  } catch (err) {
    report.errors.push(`retries: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Schedules are a separate concern; a failure there must not lose the
  // report for the enrollments advanced above.
  try {
    const { runDueSchedules } = await import('./scheduled-runs');
    report.schedules = await runDueSchedules(db, deps);
  } catch (err) {
    report.errors.push(`schedules: ${err instanceof Error ? err.message : String(err)}`);
  }
  return report;
}

/** Context a new run starts with. */
export function startContext(type: JourneyTriggerType, data: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trigger: type,
    ...(typeof data.tag_id === 'string' ? { tag_id: data.tag_id } : {}),
    ...(typeof data.button_text === 'string' ? { button_text: data.button_text } : {}),
    trigger_data: { type, ...data },
  };
}
