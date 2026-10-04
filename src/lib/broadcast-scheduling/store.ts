// ============================================================
// Supabase access for the scheduling layer.
//
// Every state transition is ONE conditional UPDATE guarded by
// `schedule_version` (and usually `schedule_status`), returning the
// matched rows. PostgREST runs it as a single statement, so the guard
// is atomic: a concurrent writer's WHERE no longer matches and it gets
// zero rows back. No read-modify-write anywhere.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export type ScheduleStatus =
  | 'scheduled'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ExecutionResult {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  passes: number;
  updated_at: string;
}

export interface ScheduleRow {
  id: string;
  account_id: string;
  status: string;
  scheduled_at: string | null;
  timezone: string;
  schedule_status: ScheduleStatus | null;
  schedule_version: number;
  scheduler_job_id: string | null;
  cloud_task_id: string | null;
  delivery_locked_at: string | null;
  execution_started_at: string | null;
  execution_attempts: number;
  execution_result: ExecutionResult | null;
  updated_at: string | null;
}

export const SCHEDULE_COLUMNS =
  'id, account_id, status, scheduled_at, timezone, schedule_status, schedule_version, scheduler_job_id, cloud_task_id, delivery_locked_at, execution_started_at, execution_attempts, execution_result, updated_at';

export async function loadScheduleRow(
  db: SupabaseClient,
  broadcastId: string,
  accountId?: string
): Promise<ScheduleRow | null> {
  let q = db.from('broadcasts').select(SCHEDULE_COLUMNS).eq('id', broadcastId);
  if (accountId) q = q.eq('account_id', accountId);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`Failed to load broadcast: ${error.message}`);
  return (data as ScheduleRow | null) ?? null;
}

/**
 * Conditional update guarded by id + schedule_version (+ optional
 * extra filters). Returns the updated row, or null when the guard
 * didn't match — i.e. someone else moved the row first.
 */
export async function updateIfVersion(
  db: SupabaseClient,
  broadcastId: string,
  version: number,
  patch: Record<string, unknown>,
  guard?: { statusIn?: (ScheduleStatus | null)[] }
): Promise<ScheduleRow | null> {
  let q = db
    .from('broadcasts')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', broadcastId)
    .eq('schedule_version', version);

  if (guard?.statusIn) {
    const named = guard.statusIn.filter((s): s is ScheduleStatus => s !== null);
    const clauses: string[] = [];
    if (named.length > 0) clauses.push(`schedule_status.in.(${named.join(',')})`);
    if (guard.statusIn.includes(null)) clauses.push('schedule_status.is.null');
    q = q.or(clauses.join(','));
  }

  const { data, error } = await q.select(SCHEDULE_COLUMNS);
  if (error) throw new Error(`Failed to update broadcast: ${error.message}`);
  return Array.isArray(data) && data.length > 0 ? (data[0] as ScheduleRow) : null;
}

export async function countRecipients(
  db: SupabaseClient,
  broadcastId: string,
  status?: string
): Promise<number> {
  let q = db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);
  if (status) q = q.eq('status', status);
  const { count, error } = await q;
  if (error) throw new Error(`Failed to count recipients: ${error.message}`);
  return count ?? 0;
}

/** Totals for execution_result, derived from recipient rows. */
export async function summarizeRecipients(
  db: SupabaseClient,
  broadcastId: string,
  passes: number
): Promise<ExecutionResult> {
  const [total, failed, pending] = await Promise.all([
    countRecipients(db, broadcastId),
    countRecipients(db, broadcastId, 'failed'),
    countRecipients(db, broadcastId, 'pending'),
  ]);
  return {
    total,
    failed,
    pending,
    // sent/delivered/read/replied all reached Meta.
    sent: Math.max(0, total - failed - pending),
    passes,
    updated_at: new Date().toISOString(),
  };
}
