// ============================================================
// Cloud Function handlers' logic, transport-agnostic.
//
//   armBroadcast      Cloud Scheduler, T-2 min → create the Cloud Task
//                     for exactly scheduled_at, mark 'queued'.
//   executeBroadcast  Cloud Tasks, at T → claim the row atomically,
//                     deliver up to `passSize` recipients through the
//                     existing deliverBroadcast(), then either finish
//                     the row or enqueue a continuation task.
//   reconcile         Cloud Scheduler, every few minutes → re-create
//                     triggers for rows that should have moved on but
//                     didn't (lost job, deleted task, crashed pass).
//
// Delivery itself is NOT reimplemented: planning reuses
// planBroadcastResume (frozen per-recipient params, phone validation,
// template resolution) and sending reuses deliverBroadcast (phone-
// variant retry, per-recipient stamping, trigger-owned counts).
//
// Uses a service-role client — the functions have no user session.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BroadcastError,
  deliverBroadcast,
  finalizeBroadcastStatus,
} from '@/lib/whatsapp/broadcast-core';
import {
  DELIVERY_LOCK_STALE_MS,
  planBroadcastResume,
} from '@/lib/whatsapp/broadcast-resume';
import { getUnsubscribedContactIds } from '@/lib/contacts/unsubscribe';

import type { SchedulingConfig } from './config';
import { schedulerJobName, type SchedulingBackend } from './gcp-backend';
import { cloudTaskId, schedulerJobId } from './ids';
import type { ArmPayload, ExecutePayload } from './schedule';
import {
  countRecipients,
  loadScheduleRow,
  SCHEDULE_COLUMNS,
  summarizeRecipients,
  updateIfVersion,
  type ScheduleRow,
} from './store';

/** Cloud Tasks accepts schedule times at most 30 days out. */
const TASKS_MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;
const IN_CHUNK = 50;

export type HandlerOutcome =
  | { outcome: 'queued'; taskName: string }
  | { outcome: 'skipped'; reason: string }
  /** Another pass holds the lock — the HTTP layer answers 503 so Cloud Tasks retries later. */
  | { outcome: 'busy' }
  | { outcome: 'continued'; nextPass: number; pending: number }
  | { outcome: 'completed'; sent: number; failed: number }
  | { outcome: 'failed'; error: string };

export function isArmPayload(v: unknown): v is ArmPayload {
  const o = v as ArmPayload;
  return !!o && typeof o.broadcastId === 'string' && Number.isInteger(o.version);
}

export function isExecutePayload(v: unknown): v is ExecutePayload {
  const o = v as ExecutePayload;
  return (
    isArmPayload(v) &&
    Number.isInteger(o.pass) &&
    ['schedule', 'retry', 'continuation', 'reconcile'].includes(o.trigger)
  );
}

// ------------------------------------------------------------------
// Arm (Scheduler → T-2 min)
// ------------------------------------------------------------------

export async function handleArm(
  db: SupabaseClient,
  backend: SchedulingBackend,
  cfg: SchedulingConfig,
  payload: ArmPayload,
  now: Date = new Date()
): Promise<HandlerOutcome> {
  const jobName = schedulerJobName(cfg, schedulerJobId(payload.broadcastId, payload.version));
  // Scheduler jobs are cron-based and would fire again next year.
  // Whatever happens below, this job has done its one job.
  const dropJob = () =>
    backend.deleteSchedulerJob(jobName).catch((err) => {
      console.warn('[broadcast-arm] job cleanup failed:', err);
    });

  const row = await loadScheduleRow(db, payload.broadcastId);
  if (!row) {
    await dropJob();
    return { outcome: 'skipped', reason: 'broadcast_deleted' };
  }
  if (row.schedule_version !== payload.version) {
    await dropJob();
    return { outcome: 'skipped', reason: 'stale_version' };
  }
  if (row.schedule_status !== 'scheduled' || !row.scheduled_at) {
    await dropJob();
    return { outcome: 'skipped', reason: `status_${row.schedule_status}` };
  }

  const scheduledAt = new Date(row.scheduled_at);
  if (scheduledAt.getTime() - now.getTime() > TASKS_MAX_AHEAD_MS) {
    // Can't happen with a T-2 min cron unless scheduled_at was edited
    // behind our back. Leave the job; the reconciler re-arms near T.
    return { outcome: 'skipped', reason: 'too_early' };
  }

  const taskName = await enqueueFirstPass(db, backend, row, 'schedule', now);
  await dropJob();
  return taskName
    ? { outcome: 'queued', taskName }
    : { outcome: 'skipped', reason: 'raced' };
}

/** Create the pass-0 task and flip the row to 'queued'. Null if the row moved meanwhile. */
async function enqueueFirstPass(
  db: SupabaseClient,
  backend: SchedulingBackend,
  row: ScheduleRow,
  trigger: 'schedule' | 'reconcile',
  now: Date,
  suffix?: string
): Promise<string | null> {
  const scheduledAt = new Date(row.scheduled_at!);
  const payload: ExecutePayload = {
    broadcastId: row.id,
    version: row.schedule_version,
    pass: 0,
    trigger,
  };
  const taskName = await backend.createTask({
    taskId: cloudTaskId(row.id, row.schedule_version, 0, suffix),
    scheduleTime: scheduledAt > now ? scheduledAt : now,
    payload,
  });

  const updated = await updateIfVersion(
    db,
    row.id,
    row.schedule_version,
    { schedule_status: 'queued', cloud_task_id: taskName, queued_at: now.toISOString() },
    { statusIn: ['scheduled', 'queued'] }
  );
  if (!updated) {
    // Rescheduled or cancelled between our read and now. The task would
    // no-op on its version check anyway; deleting it just keeps the
    // queue clean.
    await backend.deleteTask(taskName).catch(() => {});
    return null;
  }
  return taskName;
}

// ------------------------------------------------------------------
// Execute (Cloud Tasks → exactly T)
// ------------------------------------------------------------------

export interface ExecuteContext {
  now?: Date;
  /** X-CloudTasks-TaskRetryCount — 0 on the first attempt. */
  retryCount?: number;
}

/**
 * Take the delivery lock and enter 'processing' in one conditional
 * UPDATE. Shares `delivery_locked_at` with the dashboard's Resume
 * route, so a manual resume and a scheduled pass can never overlap.
 */
async function claim(
  db: SupabaseClient,
  row: ScheduleRow,
  now: Date
): Promise<boolean> {
  const staleCutoff = new Date(now.getTime() - DELIVERY_LOCK_STALE_MS).toISOString();
  const firstClaim = row.schedule_status !== 'processing';

  const patch: Record<string, unknown> = {
    schedule_status: 'processing',
    status: 'sending',
    delivery_locked_at: now.toISOString(),
    execution_attempts: row.execution_attempts + 1,
    updated_at: now.toISOString(),
  };
  if (firstClaim) patch.execution_started_at = now.toISOString();

  const { data, error } = await db
    .from('broadcasts')
    .update(patch)
    .eq('id', row.id)
    .eq('schedule_version', row.schedule_version)
    .in('schedule_status', ['scheduled', 'queued', 'processing'])
    .or(`delivery_locked_at.is.null,delivery_locked_at.lt.${staleCutoff}`)
    .select('id');

  if (error) throw new Error(`Claim failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Recipients who unsubscribed between scheduling and sending are
 * stamped failed rather than messaged.
 */
async function dropUnsubscribed(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string
): Promise<void> {
  const ids = [...(await getUnsubscribedContactIds(db, accountId))];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: 'Contact unsubscribed before the scheduled send' })
      .eq('broadcast_id', broadcastId)
      .eq('status', 'pending')
      .in('contact_id', ids.slice(i, i + IN_CHUNK));
  }
}

async function markFailed(
  db: SupabaseClient,
  row: ScheduleRow,
  error: string,
  now: Date
): Promise<HandlerOutcome> {
  const execution_result = await summarizeRecipients(
    db,
    row.id,
    row.execution_result?.passes ?? 0
  ).catch(() => row.execution_result);
  await updateIfVersion(db, row.id, row.schedule_version, {
    schedule_status: 'failed',
    status: 'failed',
    failed_at: now.toISOString(),
    last_error: error,
    last_error_at: now.toISOString(),
    delivery_locked_at: null,
    execution_result,
  });
  return { outcome: 'failed', error };
}

export async function handleExecute(
  db: SupabaseClient,
  backend: SchedulingBackend,
  cfg: SchedulingConfig,
  payload: ExecutePayload,
  ctx: ExecuteContext = {}
): Promise<HandlerOutcome> {
  const now = ctx.now ?? new Date();

  const row = await loadScheduleRow(db, payload.broadcastId);
  if (!row) return { outcome: 'skipped', reason: 'broadcast_deleted' };
  if (row.schedule_version !== payload.version) {
    return { outcome: 'skipped', reason: 'stale_version' };
  }
  if (!['scheduled', 'queued', 'processing'].includes(row.schedule_status ?? '')) {
    return { outcome: 'skipped', reason: `status_${row.schedule_status}` };
  }

  // A scheduled send that arrives hours late (outage, paused queue)
  // is more likely to annoy than to help. Fail it visibly; the user can
  // retry deliberately. Retries/continuations are never "late".
  if (
    row.schedule_status !== 'processing' &&
    (payload.trigger === 'schedule' || payload.trigger === 'reconcile') &&
    row.scheduled_at &&
    now.getTime() - new Date(row.scheduled_at).getTime() > cfg.maxLatenessMs
  ) {
    const claimed = await claim(db, row, now);
    if (!claimed) return { outcome: 'busy' };
    return markFailed(
      db,
      row,
      `missed_schedule: trigger arrived ${Math.round(
        (now.getTime() - new Date(row.scheduled_at).getTime()) / 60_000
      )} min after the scheduled time (limit ${Math.round(cfg.maxLatenessMs / 60_000)} min)`,
      now
    );
  }

  if (!(await claim(db, row, now))) {
    const fresh = await loadScheduleRow(db, row.id);
    if (
      fresh &&
      fresh.schedule_version === payload.version &&
      ['scheduled', 'queued', 'processing'].includes(fresh.schedule_status ?? '')
    ) {
      return { outcome: 'busy' };
    }
    return { outcome: 'skipped', reason: 'claimed_elsewhere' };
  }

  const pass = payload.pass;
  try {
    await dropUnsubscribed(db, row.account_id, row.id);

    let delivered = false;
    try {
      const { plan } = await planBroadcastResume(db, row.account_id, row.id, 'pending');
      await deliverBroadcast(db, { ...plan, planned: plan.planned.slice(0, cfg.passSize) });
      delivered = true;
    } catch (err) {
      if (!(err instanceof BroadcastError && err.code === 'nothing_to_resume')) throw err;
    }
    if (!delivered) await finalizeBroadcastStatus(db, row.id);

    const pending = await countRecipients(db, row.id, 'pending');
    const result = await summarizeRecipients(db, row.id, pass + 1);

    if (pending > 0) {
      // Release first, then hand off. If the enqueue below fails we
      // throw → Cloud Tasks retries THIS task, which re-claims (the
      // lock is free) and carries on from the remaining pending rows.
      await updateIfVersion(db, row.id, row.schedule_version, {
        delivery_locked_at: null,
        execution_result: result,
      });
      const next: ExecutePayload = {
        broadcastId: row.id,
        version: row.schedule_version,
        pass: pass + 1,
        trigger: 'continuation',
      };
      await backend.createTask({
        taskId: cloudTaskId(row.id, row.schedule_version, pass + 1),
        scheduleTime: new Date(),
        payload: next,
      });
      return { outcome: 'continued', nextPass: pass + 1, pending };
    }

    const allFailed = result.total > 0 && result.failed === result.total;
    const doneAt = new Date().toISOString();
    await updateIfVersion(db, row.id, row.schedule_version, {
      schedule_status: allFailed ? 'failed' : 'completed',
      ...(allFailed
        ? {
            failed_at: doneAt,
            last_error: 'Every recipient failed — see per-recipient errors.',
            last_error_at: doneAt,
          }
        : { completed_at: doneAt, last_error: null }),
      delivery_locked_at: null,
      execution_result: result,
    });
    return allFailed
      ? { outcome: 'failed', error: 'all_recipients_failed' }
      : { outcome: 'completed', sent: result.sent, failed: result.failed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Config/template problems won't fix themselves on retry.
    if (err instanceof BroadcastError) {
      return markFailed(db, row, `${err.code}: ${message}`, now);
    }
    // Transient (network, Supabase, Google). Let Cloud Tasks retry
    // unless this was the queue's last attempt.
    if ((ctx.retryCount ?? 0) + 1 >= cfg.taskMaxAttempts) {
      return markFailed(db, row, `Gave up after ${cfg.taskMaxAttempts} attempts: ${message}`, now);
    }
    await updateIfVersion(db, row.id, row.schedule_version, {
      delivery_locked_at: null,
      last_error: message,
      last_error_at: new Date().toISOString(),
    }).catch(() => {});
    throw err;
  }
}

// ------------------------------------------------------------------
// Reconcile (Scheduler → every 5 min)
// ------------------------------------------------------------------

const RECONCILE_LIMIT = 100;
/** How long a 'queued' row may sit past its time before we assume the task is lost. */
const QUEUED_GRACE_MS = 10 * 60 * 1000;
/** How long a 'processing' row may sit unlocked before we assume the continuation is lost. */
const PROCESSING_IDLE_MS = 15 * 60 * 1000;

export interface ReconcileReport {
  armed: string[];
  requeued: string[];
  resumed: string[];
  errors: { broadcastId: string; error: string }[];
}

export async function handleReconcile(
  db: SupabaseClient,
  backend: SchedulingBackend,
  cfg: SchedulingConfig,
  now: Date = new Date()
): Promise<ReconcileReport> {
  const report: ReconcileReport = { armed: [], requeued: [], resumed: [], errors: [] };
  // One bucket per 10 minutes: repeated reconciler runs inside a window
  // hit ALREADY_EXISTS instead of piling up duplicate tasks.
  const bucket = `rc${Math.floor(now.getTime() / QUEUED_GRACE_MS)}`;
  const iso = (ms: number) => new Date(now.getTime() + ms).toISOString();

  const select = (status: string) =>
    db.from('broadcasts').select(SCHEDULE_COLUMNS).eq('schedule_status', status).limit(RECONCILE_LIMIT);

  // 1. Still 'scheduled' within a minute of T: the Scheduler job never armed it.
  const { data: unarmed } = await select('scheduled').lte('scheduled_at', iso(60_000));
  // 2. 'queued' well past T: the task was lost.
  const { data: lost } = await select('queued').lt('scheduled_at', iso(-QUEUED_GRACE_MS));
  // 3. 'processing' with a stale lock, or unlocked and idle: crashed pass / lost continuation.
  const { data: stuck } = await select('processing').lt('updated_at', iso(-PROCESSING_IDLE_MS));

  for (const row of (unarmed ?? []) as ScheduleRow[]) {
    try {
      const name = await enqueueFirstPass(db, backend, row, 'reconcile', now);
      if (name) report.armed.push(row.id);
    } catch (err) {
      report.errors.push({ broadcastId: row.id, error: String(err) });
    }
  }

  for (const row of (lost ?? []) as ScheduleRow[]) {
    try {
      const name = await enqueueFirstPass(db, backend, row, 'reconcile', now, bucket);
      if (name) report.requeued.push(row.id);
    } catch (err) {
      report.errors.push({ broadcastId: row.id, error: String(err) });
    }
  }

  for (const row of (stuck ?? []) as ScheduleRow[]) {
    const lockedAt = row.delivery_locked_at ? new Date(row.delivery_locked_at).getTime() : null;
    if (lockedAt !== null && now.getTime() - lockedAt < DELIVERY_LOCK_STALE_MS) continue;
    try {
      const pass = (row.execution_result?.passes ?? 0) + 1;
      const payload: ExecutePayload = {
        broadcastId: row.id,
        version: row.schedule_version,
        pass,
        trigger: 'reconcile',
      };
      await backend.createTask({
        taskId: cloudTaskId(row.id, row.schedule_version, pass, bucket),
        scheduleTime: now,
        payload,
      });
      report.resumed.push(row.id);
    } catch (err) {
      report.errors.push({ broadcastId: row.id, error: String(err) });
    }
  }

  return report;
}
