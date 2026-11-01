// ============================================================
// Failed messages (feature 'failed_messages', migration 060).
//
// One list of an account's sends that failed — journey messages
// (journey_messages) and inbox / automation / flow sends (messages) —
// with what to do about each:
//
//   resend     the same template (or text) again, now
//   schedule   resend at a chosen time (journeyTick picks it up)
//   send_text  a custom free-form message instead — only while the
//              customer's 24-hour window is open (prefilled with the
//              template's text)
//   dismiss    stop showing it
//
// Opted-out contacts are never messaged. Every action is recorded on
// the failed row (resolved / failure_resolved), and a resend that fails
// again shows up as a new failed row. Service-role client; callers check
// account membership first (every query here is also account-scoped).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { ensureConversation, type JourneyDeps } from '@/lib/journeys/engine';
import { recordJourneyMessage } from '@/lib/journeys/messages';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { explainFailure, type FailureFix } from '@/lib/whatsapp/error-hints';

export type FailedSource = 'journey' | 'inbox';
export type FailedAction = 'resend' | 'schedule' | 'cancel_schedule' | 'send_text' | 'dismiss';
export type SendDeps = Pick<JourneyDeps, 'now' | 'sendTemplate' | 'sendText'>;

const WINDOW_MS = 24 * 3600_000;
const MAX_SCHEDULE_MS = 30 * 24 * 3600_000;
const LIST_LIMIT = 500;

export interface FailedItem {
  key: string;
  source: FailedSource;
  id: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  conversation_id: string | null;
  journey_name: string | null;
  kind: 'template' | 'text';
  template_name: string | null;
  language: string | null;
  params: string[] | null;
  content_text: string | null;
  error_code: number | null;
  error_title: string | null;
  reason: string;
  fix: FailureFix;
  retryable: boolean;
  failed_at: string;
  resolved: string | null;
  resolved_at: string | null;
  scheduled_at: string | null;
  window_open: boolean;
  window_closes_at: string | null;
  opted_out: boolean;
  /** Why "resend" can't work for this one (null = it can). */
  resend_blocked: 'needs_variables' | 'window_closed' | 'opted_out' | 'no_contact' | null;
}

export interface FailedList {
  items: FailedItem[];
  stats: { failed: number; open: number; resolved: number; scheduled: number; window_open: number };
  reasons: { reason: string; code: number | null; count: number }[];
}

interface JourneyRowDb {
  id: string;
  account_id: string;
  journey_id: string;
  enrollment_id: string;
  contact_id: string;
  node_id: string;
  kind: string;
  template_name: string | null;
  language: string | null;
  params: string[] | null;
  content_text: string | null;
  wa_message_id: string | null;
  status: string;
  error_code: number | null;
  error_title: string | null;
  attempt: number;
  retry_until: string | null;
  resolved: string | null;
  resolved_at: string | null;
  manual_retry_at: string | null;
  created_at: string;
}

interface InboxRowDb {
  id: string;
  conversation_id: string;
  sender_type: string;
  content_type: string;
  content_text: string | null;
  template_name: string | null;
  message_id: string | null;
  status: string;
  error_code: number | null;
  error_title: string | null;
  failure_resolved: string | null;
  failure_resolved_at: string | null;
  manual_retry_at: string | null;
  created_at: string;
  conversations?: { account_id: string; contact_id: string; last_customer_message_at: string | null } | { account_id: string; contact_id: string; last_customer_message_at: string | null }[] | null;
}

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/** Template body has variables we don't have for an inbox send. */
async function needsVariables(db: SupabaseClient, accountId: string, name: string, language: string | null): Promise<boolean> {
  const { row } = await resolveTemplateRow(db, accountId, name, language);
  return /\{\{\s*\d+\s*\}\}/.test(String(row?.body_text ?? ''));
}

async function contactFacts(db: SupabaseClient, accountId: string, contactIds: string[]) {
  const ids = [...new Set(contactIds.filter(Boolean))];
  const contacts = new Map<string, { name: string | null; phone: string | null }>();
  const optedOut = new Set<string>();
  const lastCustomer = new Map<string, { conv: string; at: string | null }>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const [{ data: cs }, { data: tags }, { data: convs }] = await Promise.all([
      db.from('contacts').select('id, name, phone').eq('account_id', accountId).in('id', chunk),
      db.from('contact_tags').select('contact_id, tags(name)').in('contact_id', chunk),
      db.from('conversations').select('id, contact_id, last_customer_message_at').eq('account_id', accountId).in('contact_id', chunk),
    ]);
    for (const c of cs ?? []) contacts.set(c.id as string, { name: (c.name as string) ?? null, phone: (c.phone as string) ?? null });
    for (const t of (tags ?? []) as { contact_id: string; tags?: { name?: string } | { name?: string }[] | null }[]) {
      if ((one(t.tags)?.name ?? '').trim().toLowerCase() === 'unsubscribe') optedOut.add(t.contact_id);
    }
    for (const c of convs ?? []) {
      lastCustomer.set(c.contact_id as string, { conv: c.id as string, at: (c.last_customer_message_at as string) ?? null });
    }
  }
  return { contacts, optedOut, lastCustomer };
}

function windowOf(at: string | null | undefined, now: Date) {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return { open: false, closes: null as string | null };
  const closes = t + WINDOW_MS;
  return { open: closes > now.getTime(), closes: new Date(closes).toISOString() };
}

/** Failed sends of an account between `from` and `to` (ISO). */
export async function listFailed(
  db: SupabaseClient,
  accountId: string,
  args: { from: string; to: string; status?: 'open' | 'resolved' | 'all'; now: Date }
): Promise<FailedList> {
  const status = args.status ?? 'open';

  const { data: jRows, error: jErr } = await db
    .from('journey_messages')
    .select('*')
    .eq('account_id', accountId)
    .eq('status', 'failed')
    .gte('created_at', args.from)
    .lt('created_at', args.to)
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT);
  if (jErr) throw new Error(jErr.message);
  // A retry chain shows once: its latest attempt ('retried' rows are steps).
  const journeyRows = ((jRows ?? []) as JourneyRowDb[]).filter((r) => r.resolved !== 'retried');
  const journeyWamids = new Set(((jRows ?? []) as JourneyRowDb[]).map((r) => r.wa_message_id).filter(Boolean));

  const { data: iRows, error: iErr } = await db
    .from('messages')
    .select('id, conversation_id, sender_type, content_type, content_text, template_name, message_id, status, error_code, error_title, failure_resolved, failure_resolved_at, manual_retry_at, created_at, conversations!inner(account_id, contact_id, last_customer_message_at)')
    .eq('conversations.account_id', accountId)
    .eq('status', 'failed')
    .in('sender_type', ['agent', 'bot'])
    .gte('created_at', args.from)
    .lt('created_at', args.to)
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT);
  if (iErr) throw new Error(iErr.message);
  // Journey sends also land in messages — keep the journey copy.
  const inboxRows = ((iRows ?? []) as InboxRowDb[]).filter((r) => !r.message_id || !journeyWamids.has(r.message_id));

  const contactIds = [
    ...journeyRows.map((r) => r.contact_id),
    ...inboxRows.map((r) => one(r.conversations)?.contact_id ?? ''),
  ];
  const facts = await contactFacts(db, accountId, contactIds);
  const journeyIds = [...new Set(journeyRows.map((r) => r.journey_id))];
  const { data: js } = journeyIds.length
    ? await db.from('journeys').select('id, name').eq('account_id', accountId).in('id', journeyIds)
    : { data: [] };
  const journeyName = new Map((js ?? []).map((j) => [j.id as string, j.name as string]));

  const items: FailedItem[] = [];
  for (const r of journeyRows) {
    const hint = explainFailure(r.error_code, r.error_title);
    const conv = facts.lastCustomer.get(r.contact_id);
    const w = windowOf(conv?.at, args.now);
    const c = facts.contacts.get(r.contact_id);
    const isTemplate = r.kind === 'template' || r.kind === 'retry';
    const optedOut = facts.optedOut.has(r.contact_id);
    items.push({
      key: `journey:${r.id}`,
      source: 'journey',
      id: r.id,
      contact_id: r.contact_id,
      contact_name: c?.name ?? null,
      contact_phone: c?.phone ?? null,
      conversation_id: conv?.conv ?? null,
      journey_name: journeyName.get(r.journey_id) ?? null,
      kind: isTemplate ? 'template' : 'text',
      template_name: r.template_name,
      language: r.language,
      params: r.params,
      content_text: r.content_text,
      error_code: r.error_code,
      error_title: r.error_title,
      reason: hint.reason,
      fix: hint.fix,
      retryable: hint.retryable,
      failed_at: r.created_at,
      resolved: r.resolved,
      resolved_at: r.resolved_at ?? null,
      scheduled_at: r.resolved ? null : r.manual_retry_at,
      window_open: w.open,
      window_closes_at: w.closes,
      opted_out: optedOut,
      resend_blocked: !c ? 'no_contact' : optedOut ? 'opted_out' : !isTemplate && !w.open ? 'window_closed' : null,
    });
  }
  const variablesCache = new Map<string, boolean>();
  for (const r of inboxRows) {
    const conv = one(r.conversations);
    const contactId = conv?.contact_id ?? null;
    const hint = explainFailure(r.error_code, r.error_title);
    const w = windowOf(conv?.last_customer_message_at, args.now);
    const c = contactId ? facts.contacts.get(contactId) : undefined;
    const isTemplate = r.content_type === 'template' && Boolean(r.template_name);
    let needsVars = false;
    if (isTemplate) {
      const k = String(r.template_name);
      if (!variablesCache.has(k)) variablesCache.set(k, await needsVariables(db, accountId, k, null));
      needsVars = variablesCache.get(k)!;
    }
    const optedOut = contactId ? facts.optedOut.has(contactId) : false;
    items.push({
      key: `inbox:${r.id}`,
      source: 'inbox',
      id: r.id,
      contact_id: contactId,
      contact_name: c?.name ?? null,
      contact_phone: c?.phone ?? null,
      conversation_id: r.conversation_id,
      journey_name: null,
      kind: isTemplate ? 'template' : 'text',
      template_name: r.template_name,
      language: null,
      params: null,
      content_text: r.content_text,
      error_code: r.error_code,
      error_title: r.error_title,
      reason: hint.reason,
      fix: hint.fix,
      retryable: hint.retryable,
      failed_at: r.created_at,
      resolved: r.failure_resolved,
      resolved_at: r.failure_resolved_at,
      scheduled_at: r.failure_resolved ? null : r.manual_retry_at,
      window_open: w.open,
      window_closes_at: w.closes,
      opted_out: optedOut,
      resend_blocked: !c ? 'no_contact' : optedOut ? 'opted_out' : isTemplate ? (needsVars ? 'needs_variables' : null) : !w.open ? 'window_closed' : null,
    });
  }
  items.sort((a, b) => Date.parse(b.failed_at) - Date.parse(a.failed_at));

  const reasons = new Map<string, { reason: string; code: number | null; count: number }>();
  for (const i of items) {
    const k = `${i.error_code ?? ''}|${i.reason}`;
    const e = reasons.get(k) ?? { reason: i.reason, code: i.error_code, count: 0 };
    e.count++;
    reasons.set(k, e);
  }
  const open = items.filter((i) => !i.resolved);
  const stats = {
    failed: items.length,
    open: open.length,
    resolved: items.length - open.length,
    scheduled: open.filter((i) => i.scheduled_at).length,
    window_open: open.filter((i) => i.window_open && !i.opted_out).length,
  };
  const shown = status === 'all' ? items : status === 'open' ? open : items.filter((i) => i.resolved);
  return { items: shown, stats, reasons: [...reasons.values()].sort((a, b) => b.count - a.count).slice(0, 8) };
}

// ------------------------------------------------------------------
// Actions
// ------------------------------------------------------------------

export type ActionError =
  | 'not_found'
  | 'already_resolved'
  | 'opted_out'
  | 'window_closed'
  | 'needs_variables'
  | 'no_contact'
  | 'bad_time'
  | 'empty_text'
  | 'send_failed';

export interface ActionResult {
  key: string;
  ok: boolean;
  error?: ActionError;
  detail?: string;
}

interface Loaded {
  source: FailedSource;
  row: JourneyRowDb | InboxRowDb;
  accountId: string;
  contactId: string | null;
  conversationId: string | null;
  lastCustomerAt: string | null;
  createdBy: string | null;
  resolved: string | null;
}

async function load(db: SupabaseClient, accountId: string, key: string): Promise<Loaded | null> {
  const [source, id] = key.split(':') as [FailedSource, string];
  if (source === 'journey') {
    const { data } = await db.from('journey_messages').select('*').eq('id', id).eq('account_id', accountId).maybeSingle();
    if (!data || data.status !== 'failed') return null;
    const row = data as JourneyRowDb;
    const [{ data: conv }, { data: j }] = await Promise.all([
      db.from('conversations').select('id, last_customer_message_at').eq('account_id', accountId).eq('contact_id', row.contact_id).maybeSingle(),
      db.from('journeys').select('created_by').eq('id', row.journey_id).maybeSingle(),
    ]);
    return {
      source,
      row,
      accountId,
      contactId: row.contact_id,
      conversationId: (conv?.id as string) ?? null,
      lastCustomerAt: (conv?.last_customer_message_at as string) ?? null,
      createdBy: (j?.created_by as string) ?? null,
      resolved: row.resolved,
    };
  }
  if (source === 'inbox') {
    const { data } = await db
      .from('messages')
      .select('*, conversations!inner(account_id, contact_id, last_customer_message_at, user_id)')
      .eq('id', id)
      .eq('conversations.account_id', accountId)
      .maybeSingle();
    if (!data || data.status !== 'failed') return null;
    const row = data as InboxRowDb & { conversations: unknown };
    const conv = one(row.conversations as { account_id: string; contact_id: string; last_customer_message_at: string | null; user_id?: string } | null);
    if (!conv || conv.account_id !== accountId) return null;
    return {
      source,
      row,
      accountId,
      contactId: conv.contact_id,
      conversationId: row.conversation_id,
      lastCustomerAt: conv.last_customer_message_at,
      createdBy: conv.user_id ?? null,
      resolved: row.failure_resolved,
    };
  }
  return null;
}

async function isOptedOut(db: SupabaseClient, contactId: string): Promise<boolean> {
  const { data } = await db.from('contact_tags').select('tags(name)').eq('contact_id', contactId);
  return ((data ?? []) as { tags?: { name?: string } | { name?: string }[] | null }[]).some(
    (r) => (one(r.tags)?.name ?? '').trim().toLowerCase() === 'unsubscribe'
  );
}

async function markResolved(db: SupabaseClient, it: Loaded, resolved: 'resent' | 'custom_text' | 'dismissed', now: Date) {
  const at = now.toISOString();
  if (it.source === 'journey') {
    await db.from('journey_messages').update({ resolved, resolved_at: at, next_retry_at: null, manual_retry_at: null }).eq('id', it.row.id);
  } else {
    await db.from('messages').update({ failure_resolved: resolved, failure_resolved_at: at, manual_retry_at: null }).eq('id', it.row.id);
  }
}

/** Send `text` (custom message) or resend the original, and record it. */
async function deliver(
  db: SupabaseClient,
  it: Loaded,
  mode: { text: string } | 'original',
  deps: SendDeps,
  userId: string | null
): Promise<ActionResult> {
  const key = `${it.source}:${it.row.id}`;
  const now = deps.now();
  if (!it.contactId) return { key, ok: false, error: 'no_contact' };
  if (await isOptedOut(db, it.contactId)) return { key, ok: false, error: 'opted_out' };

  const jr = it.source === 'journey' ? (it.row as JourneyRowDb) : null;
  const ir = it.source === 'inbox' ? (it.row as InboxRowDb) : null;
  const isTemplate = jr ? jr.kind === 'template' || jr.kind === 'retry' : ir!.content_type === 'template' && Boolean(ir!.template_name);
  const text = mode === 'original' ? (isTemplate ? null : (jr?.content_text ?? ir?.content_text ?? '')) : mode.text;
  if (text !== null) {
    if (!text.trim()) return { key, ok: false, error: 'empty_text' };
    if (!windowOf(it.lastCustomerAt, now).open) return { key, ok: false, error: 'window_closed' };
  } else if (ir && (await needsVariables(db, it.accountId, String(ir.template_name), null))) {
    return { key, ok: false, error: 'needs_variables' };
  }

  const ctx = {
    accountId: it.accountId,
    userId: userId ?? it.createdBy ?? '',
    contactId: it.contactId,
    conversationId: it.conversationId ?? (await ensureConversation(db, it.accountId, it.contactId, it.createdBy)),
  };
  let sent: { whatsapp_message_id?: string; content_text?: string | null } = {};
  let error: string | null = null;
  try {
    sent =
      (text !== null
        ? await deps.sendText(ctx, text)
        : await deps.sendTemplate(ctx, {
            template_name: String(jr?.template_name ?? ir?.template_name),
            language: jr?.language ?? undefined,
            params: jr?.params ?? [],
          })) || {};
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (jr) {
    // Keep the run's message log complete (a new failure shows up as a new row).
    await recordJourneyMessage(
      db,
      {
        account_id: jr.account_id,
        journey_id: jr.journey_id,
        enrollment_id: jr.enrollment_id,
        contact_id: jr.contact_id,
        node_id: jr.node_id,
        kind: text !== null ? 'fallback' : 'retry',
        template_name: jr.template_name,
        language: jr.language,
        params: jr.params,
        content_text: text ?? sent.content_text ?? jr.content_text,
        wa_message_id: sent.whatsapp_message_id ?? null,
        status: error ? 'failed' : 'sent',
        error,
        attempt: (jr.attempt ?? 1) + 1,
        parent_id: jr.id,
        retry_until: jr.retry_until,
      },
      now
    );
  }
  // The failed one is handled either way; a new failure is its own row
  // (journeys) or its own failed message (inbox sends).
  await markResolved(db, it, text !== null && mode !== 'original' ? 'custom_text' : 'resent', now);
  return error ? { key, ok: false, error: 'send_failed', detail: error } : { key, ok: true };
}

/** Apply one action to failed items (keys "journey:<id>" / "inbox:<id>"). */
export async function actOnFailed(
  db: SupabaseClient,
  args: { accountId: string; userId: string | null; keys: string[]; action: FailedAction; at?: string; text?: string },
  deps: SendDeps
): Promise<ActionResult[]> {
  const out: ActionResult[] = [];
  const now = deps.now();
  for (const key of [...new Set(args.keys)].slice(0, 200)) {
    const it = await load(db, args.accountId, key);
    if (!it) {
      out.push({ key, ok: false, error: 'not_found' });
      continue;
    }
    if (it.resolved) {
      out.push({ key, ok: false, error: 'already_resolved' });
      continue;
    }
    const table = it.source === 'journey' ? 'journey_messages' : 'messages';
    switch (args.action) {
      case 'dismiss':
        await markResolved(db, it, 'dismissed', now);
        out.push({ key, ok: true });
        break;
      case 'cancel_schedule':
        await db.from(table).update({ manual_retry_at: null }).eq('id', it.row.id);
        out.push({ key, ok: true });
        break;
      case 'schedule': {
        const at = Date.parse(String(args.at ?? ''));
        if (!Number.isFinite(at) || at <= now.getTime() || at > now.getTime() + MAX_SCHEDULE_MS) {
          out.push({ key, ok: false, error: 'bad_time' });
          break;
        }
        if (it.contactId && (await isOptedOut(db, it.contactId))) {
          out.push({ key, ok: false, error: 'opted_out' });
          break;
        }
        const ir = it.source === 'inbox' ? (it.row as InboxRowDb) : null;
        if (ir?.content_type === 'template' && ir.template_name && (await needsVariables(db, it.accountId, ir.template_name, null))) {
          out.push({ key, ok: false, error: 'needs_variables' });
          break;
        }
        // A scheduled journey resend replaces any automatic retry.
        await db
          .from(table)
          .update(it.source === 'journey' ? { manual_retry_at: new Date(at).toISOString(), next_retry_at: null } : { manual_retry_at: new Date(at).toISOString() })
          .eq('id', it.row.id);
        out.push({ key, ok: true });
        break;
      }
      case 'resend':
        out.push(await deliver(db, it, 'original', deps, args.userId));
        break;
      case 'send_text': {
        const text = String(args.text ?? '').slice(0, 4096);
        out.push(await deliver(db, it, { text }, deps, args.userId));
        break;
      }
    }
  }
  return out;
}

/** journeyTick: resends whose scheduled time has come. */
export async function runScheduledResends(db: SupabaseClient, deps: SendDeps): Promise<{ sent: number; failed: number; skipped: number }> {
  const report = { sent: 0, failed: 0, skipped: 0 };
  const nowIso = deps.now().toISOString();
  for (const table of ['journey_messages', 'messages'] as const) {
    const { data } = await db.from(table).select('id, manual_retry_at').lte('manual_retry_at', nowIso).limit(50);
    for (const row of (data ?? []) as { id: string; manual_retry_at: string }[]) {
      // Claim: clear the time so a parallel tick skips it.
      const { data: claimed } = await db
        .from(table)
        .update({ manual_retry_at: null })
        .eq('id', row.id)
        .eq('manual_retry_at', row.manual_retry_at)
        .select('id');
      if (!claimed?.length) continue;
      const accountId = await accountOf(db, table, row.id);
      const it = accountId ? await load(db, accountId, `${table === 'journey_messages' ? 'journey' : 'inbox'}:${row.id}`) : null;
      if (!it || it.resolved) {
        report.skipped++;
        continue;
      }
      const r = await deliver(db, it, 'original', deps, null);
      if (r.ok) report.sent++;
      else if (r.error === 'send_failed') report.failed++;
      else report.skipped++;
    }
  }
  return report;
}

async function accountOf(db: SupabaseClient, table: 'journey_messages' | 'messages', id: string): Promise<string | null> {
  if (table === 'journey_messages') {
    const { data } = await db.from('journey_messages').select('account_id').eq('id', id).maybeSingle();
    return (data?.account_id as string) ?? null;
  }
  const { data } = await db.from('messages').select('conversation_id').eq('id', id).maybeSingle();
  if (!data) return null;
  const { data: conv } = await db.from('conversations').select('account_id').eq('id', data.conversation_id).maybeSingle();
  return (conv?.account_id as string) ?? null;
}
