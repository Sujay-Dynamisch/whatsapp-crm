// ============================================================
// Journey message log (migration 056).
//
// Every message a journey run sends is recorded in journey_messages so
// admins can see, per contact, what was sent and what happened to it.
// Failed templates get a second chance two ways:
//   * retry   — the journey tick re-sends the same template after a
//               delay, for Meta errors that are worth retrying (131049
//               "healthy ecosystem engagement", rate limits, outages),
//               but never after the message's retry_until.
//   * fallback — when the customer next messages us (24-hour window
//               open), the same content goes out as plain text.
// Everything here is best effort: tracking must never break a send.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUnsubscribeText, UNSUBSCRIBE_TAG_NAME } from '@/lib/contacts/unsubscribe';

/** Meta error codes where sending the same template again later can work. */
export const RETRYABLE_ERROR_CODES = new Set([
  131049, // "not delivered to maintain healthy ecosystem engagement" (per-user marketing limit)
  131056, // too many messages to this user (pair rate limit)
  130429, // throughput rate limit
  131016, // service unavailable
  131000, // something went wrong
]);
/** Total sends of one template step (first try + retries). */
export const MAX_TEMPLATE_ATTEMPTS = 3;
/** Wait before retry N (index = attempts already made − 1). */
export const RETRY_DELAYS_MS = [4 * 3600_000, 8 * 3600_000];
/** A template without its own retry_until may be retried / fallen back for this long. */
export const DEFAULT_RETRY_WINDOW_MS = 24 * 3600_000;

export type JourneyMessageKind = 'template' | 'text' | 'media' | 'buttons' | 'retry' | 'fallback';
export type JourneyMessageStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface SendResult {
  whatsapp_message_id?: string;
  /** The text the customer sees (templates: body with params filled in). */
  content_text?: string | null;
}

export interface JourneyMessageRow {
  id: string;
  account_id: string;
  journey_id: string;
  enrollment_id: string;
  contact_id: string;
  node_id: string;
  kind: JourneyMessageKind;
  template_name: string | null;
  language: string | null;
  params: string[] | null;
  content_text: string | null;
  wa_message_id: string | null;
  status: JourneyMessageStatus;
  error_code: number | null;
  attempt: number;
  retry_until: string | null;
  next_retry_at: string | null;
  created_at: string;
}

/** "(#132001) Template name…" / "[131049] …" → 132001 / 131049. */
export function metaErrorCode(message: string | null | undefined): number | null {
  const m = String(message ?? '').match(/[(#[]\s*#?(\d{3,6})\s*[)\]]/);
  return m ? Number(m[1]) : null;
}

/** When to retry a failed template, or null when it shouldn't be retried. */
export function planRetry(args: {
  kind: JourneyMessageKind;
  attempt: number;
  errorCode: number | null;
  retryUntil: string | null;
  now: Date;
}): string | null {
  if (args.kind !== 'template' && args.kind !== 'retry') return null;
  if (args.errorCode === null || !RETRYABLE_ERROR_CODES.has(args.errorCode)) return null;
  if (args.attempt >= MAX_TEMPLATE_ATTEMPTS) return null;
  const delay = RETRY_DELAYS_MS[Math.min(args.attempt - 1, RETRY_DELAYS_MS.length - 1)];
  const at = args.now.getTime() + delay;
  const until = args.retryUntil ? Date.parse(args.retryUntil) : NaN;
  if (Number.isFinite(until) && at >= until) return null;
  return new Date(at).toISOString();
}

const LADDER: JourneyMessageStatus[] = ['sent', 'delivered', 'read'];

/** Forward-only: sent → delivered → read; failed only before delivery. */
export function isForwardStatus(current: string, incoming: string): boolean {
  if (incoming === 'failed') return current === 'sent';
  const c = LADDER.indexOf(current as JourneyMessageStatus);
  const i = LADDER.indexOf(incoming as JourneyMessageStatus);
  return i >= 0 && (c < 0 || i > c);
}

export interface RecordInput {
  account_id: string;
  journey_id: string;
  enrollment_id: string;
  contact_id: string;
  node_id: string;
  kind: JourneyMessageKind;
  template_name?: string | null;
  language?: string | null;
  params?: string[] | null;
  content_text?: string | null;
  wa_message_id?: string | null;
  status: JourneyMessageStatus;
  error?: string | null;
  attempt?: number;
  parent_id?: string | null;
  retry_until?: string | null;
}

/** Insert one log row. Never throws (returns null on error). */
export async function recordJourneyMessage(db: SupabaseClient, input: RecordInput, now: Date): Promise<string | null> {
  try {
    const { error: errorText, ...row } = input;
    const errorCode = input.status === 'failed' ? metaErrorCode(errorText) : null;
    const attempt = input.attempt ?? 1;
    const { data, error } = await db
      .from('journey_messages')
      .insert({
        ...row,
        attempt,
        created_at: now.toISOString(),
        error_code: errorCode,
        error_title: input.status === 'failed' ? (errorText ?? 'Send failed').slice(0, 1000) : null,
        next_retry_at:
          input.status === 'failed'
            ? planRetry({ kind: input.kind, attempt, errorCode, retryUntil: input.retry_until ?? null, now })
            : null,
      })
      .select('id')
      .single();
    if (error) throw error;
    return data.id as string;
  } catch (err) {
    console.error('[journeys] could not record message:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Status webhook mirror: apply Meta's sent / delivered / read / failed
 * to the journey message with this id, and schedule a retry for a
 * retryable failure. Never throws.
 */
export async function applyJourneyMessageStatus(
  db: SupabaseClient,
  waMessageId: string,
  status: string,
  failure: { code: number; title: string; details: string | null } | null,
  now: Date = new Date()
): Promise<void> {
  try {
    const { data: rows } = await db
      .from('journey_messages')
      .select('id, kind, status, attempt, retry_until')
      .eq('wa_message_id', waMessageId);
    for (const row of (rows ?? []) as Pick<JourneyMessageRow, 'id' | 'kind' | 'status' | 'attempt' | 'retry_until'>[]) {
      if (!isForwardStatus(row.status, status)) continue;
      const patch: Record<string, unknown> = { status };
      if (status === 'failed') {
        const code = failure && Number.isInteger(failure.code) ? failure.code : null;
        patch.error_code = code;
        patch.error_title = failure?.title ?? 'Not delivered';
        patch.error_details = failure?.details ?? null;
        patch.next_retry_at = planRetry({ kind: row.kind, attempt: row.attempt, errorCode: code, retryUntil: row.retry_until, now });
      }
      await db.from('journey_messages').update(patch).eq('id', row.id);
    }
  } catch (err) {
    console.error('[journeys] message status mirror failed:', err instanceof Error ? err.message : err);
  }
}

/** Has the contact opted out (the 'unsubscribe' tag)? */
export async function contactOptedOut(db: SupabaseClient, contactId: string): Promise<boolean> {
  const { data } = await db.from('contact_tags').select('tags(name)').eq('contact_id', contactId);
  return (data ?? []).some((r) => {
    const t = (Array.isArray(r.tags) ? r.tags[0] : r.tags) as { name?: string } | null;
    return t?.name?.trim().toLowerCase() === UNSUBSCRIBE_TAG_NAME;
  });
}

/** Failed, unresolved template sends of a contact that are still worth delivering, newest first. */
async function pendingFailures(db: SupabaseClient, contactId: string, now: Date): Promise<JourneyMessageRow[]> {
  const { data } = await db
    .from('journey_messages')
    .select('*')
    .eq('contact_id', contactId)
    .eq('status', 'failed')
    .is('resolved', null)
    .in('kind', ['template', 'retry'])
    .gte('created_at', new Date(now.getTime() - 7 * 24 * 3600_000).toISOString())
    .order('created_at', { ascending: false })
    .limit(50);
  return ((data ?? []) as JourneyMessageRow[]).filter((r) => !r.retry_until || Date.parse(r.retry_until) > now.getTime());
}

async function resolve(db: SupabaseClient, ids: string[], resolved: string) {
  if (ids.length) await db.from('journey_messages').update({ resolved, next_retry_at: null }).in('id', ids);
}

/**
 * The customer just messaged us, so the 24-hour window is open: re-send
 * each run's latest undelivered template as plain text. Older failed
 * messages of the same run are marked superseded. Returns the runs that
 * got a fallback (their pending "wait for reply" should not consume this
 * message — the customer hadn't seen the question). Never throws.
 */
export async function sendJourneyFallbacks(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; inboundText?: string | null; now: Date },
  sendText: (row: JourneyMessageRow, text: string) => Promise<SendResult | void>
): Promise<Set<string>> {
  const handled = new Set<string>();
  try {
    const failed = await pendingFailures(db, args.contactId, args.now);
    if (!failed.length) return handled;
    if (isUnsubscribeText(args.inboundText)) {
      await resolve(db, failed.map((r) => r.id), 'opted_out');
      return handled;
    }

    const { data: runs } = await db
      .from('journey_enrollments')
      .select('id, status')
      .in('id', [...new Set(failed.map((r) => r.enrollment_id))]);
    const live = new Set(((runs ?? []) as { id: string; status: string }[]).filter((r) => r.status !== 'exited').map((r) => r.id));

    const superseded: string[] = [];
    for (const row of failed) {
      if (row.account_id !== args.accountId) continue;
      if (handled.has(row.enrollment_id) || !live.has(row.enrollment_id) || !row.content_text?.trim()) {
        superseded.push(row.id);
        continue;
      }
      try {
        const sent = (await sendText(row, row.content_text)) || {};
        await recordJourneyMessage(
          db,
          {
            account_id: row.account_id,
            journey_id: row.journey_id,
            enrollment_id: row.enrollment_id,
            contact_id: row.contact_id,
            node_id: row.node_id,
            kind: 'fallback',
            template_name: row.template_name,
            content_text: row.content_text,
            wa_message_id: sent.whatsapp_message_id ?? null,
            status: 'sent',
            parent_id: row.id,
          },
          args.now
        );
        await resolve(db, [row.id], 'fallback_sent');
        handled.add(row.enrollment_id);
      } catch (err) {
        console.error('[journeys] fallback send failed:', err instanceof Error ? err.message : err);
      }
    }
    await resolve(db, superseded, 'superseded');
  } catch (err) {
    console.error('[journeys] fallbacks failed:', err instanceof Error ? err.message : err);
  }
  return handled;
}

export interface RetryReport {
  retried: number;
  expired: number;
  superseded: number;
  failed: number;
}

/**
 * Journey tick: re-send failed templates whose retry is due. A row is
 * dropped instead when its window passed, a newer message of the same
 * run went out since, the run was stopped, or the contact opted out.
 */
export async function runJourneyRetries(
  db: SupabaseClient,
  now: Date,
  sendTemplate: (row: JourneyMessageRow) => Promise<SendResult | void>
): Promise<RetryReport> {
  const report: RetryReport = { retried: 0, expired: 0, superseded: 0, failed: 0 };
  const { data, error } = await db
    .from('journey_messages')
    .select('*')
    .eq('status', 'failed')
    .is('resolved', null)
    .lte('next_retry_at', now.toISOString())
    .order('next_retry_at', { ascending: true })
    .limit(50);
  if (error) throw new Error(`journey_messages query failed: ${error.message}`);

  for (const row of (data ?? []) as JourneyMessageRow[]) {
    // Claim: clear next_retry_at so a parallel tick skips it.
    const { data: claimed } = await db
      .from('journey_messages')
      .update({ next_retry_at: null })
      .eq('id', row.id)
      .eq('next_retry_at', row.next_retry_at)
      .select('id');
    if (!claimed?.length) continue;

    if (row.retry_until && Date.parse(row.retry_until) <= now.getTime()) {
      await resolve(db, [row.id], 'expired');
      report.expired++;
      continue;
    }
    const { count: newer } = await db
      .from('journey_messages')
      .select('id', { count: 'exact', head: true })
      .eq('enrollment_id', row.enrollment_id)
      .gt('created_at', row.created_at);
    const { data: run } = await db.from('journey_enrollments').select('status').eq('id', row.enrollment_id).maybeSingle();
    if ((newer ?? 0) > 0 || !run || run.status === 'exited') {
      await resolve(db, [row.id], 'superseded');
      report.superseded++;
      continue;
    }
    if (await contactOptedOut(db, row.contact_id)) {
      await resolve(db, [row.id], 'opted_out');
      report.superseded++;
      continue;
    }

    const base = {
      account_id: row.account_id,
      journey_id: row.journey_id,
      enrollment_id: row.enrollment_id,
      contact_id: row.contact_id,
      node_id: row.node_id,
      kind: 'retry' as const,
      template_name: row.template_name,
      language: row.language,
      params: row.params,
      attempt: row.attempt + 1,
      parent_id: row.id,
      retry_until: row.retry_until,
    };
    try {
      const sent = (await sendTemplate(row)) || {};
      await recordJourneyMessage(
        db,
        { ...base, content_text: sent.content_text ?? row.content_text, wa_message_id: sent.whatsapp_message_id ?? null, status: 'sent' },
        now
      );
      report.retried++;
    } catch (err) {
      await recordJourneyMessage(
        db,
        { ...base, content_text: row.content_text, status: 'failed', error: err instanceof Error ? err.message : String(err) },
        now
      );
      report.failed++;
    }
    await resolve(db, [row.id], 'retried');
  }
  return report;
}
