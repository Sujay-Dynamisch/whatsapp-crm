// ============================================================
// User-facing scheduling operations: create / reschedule, cancel,
// retry. Called from the Next.js API routes with the caller's
// RLS-scoped Supabase client — no service-role key involved.
//
// Pattern for every operation:
//
//   1. Bump schedule_version in ONE conditional UPDATE. From this
//      instant every Google-side trigger created for an older version
//      is a no-op (arm/execute compare versions before doing anything).
//   2. Best-effort delete the old version's job/task. Not required for
//      correctness — only tidiness and quota.
//   3. Create the new version's trigger (deterministic name, so a
//      retried request can't create two).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { SchedulingConfig } from './config';
import type { SchedulingBackend } from './gcp-backend';
import { cloudTaskId, schedulerJobId } from './ids';
import {
  countRecipients,
  loadScheduleRow,
  updateIfVersion,
  type ScheduleRow,
  type ScheduleStatus,
} from './store';
import { computeArmTime, isValidTimeZone, schedulerCron, utcToZonedLocal } from './time';
import { DELIVERY_LOCK_STALE_MS } from '@/lib/whatsapp/broadcast-resume';

export class ScheduleError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
    this.status = status;
  }
}

/** Body of the Scheduler job → armBroadcast. */
export interface ArmPayload {
  broadcastId: string;
  version: number;
}

export type TaskTrigger = 'schedule' | 'retry' | 'continuation' | 'reconcile';

/** Body of every Cloud Task → executeBroadcast. */
export interface ExecutePayload {
  broadcastId: string;
  version: number;
  pass: number;
  trigger: TaskTrigger;
}

export interface ScheduleResult {
  broadcastId: string;
  scheduledAt: string;
  timezone: string;
  scheduleStatus: ScheduleStatus;
  version: number;
  schedulerJobId: string | null;
  cloudTaskId: string | null;
  /** Which Google service holds the trigger right now. */
  trigger: 'scheduler' | 'task';
}

/** Slack for clock skew between the browser and the server. */
const PAST_TOLERANCE_MS = 60_000;
/**
 * A Scheduler cron has no year field, so it only identifies a unique
 * minute within the next 12 months.
 */
const MAX_HORIZON_MS = 364 * 24 * 60 * 60 * 1000;
/** Within this much of the send, skip Scheduler and enqueue the task directly. */
const DIRECT_TASK_MARGIN_MS = 60_000;

const RESCHEDULABLE: (ScheduleStatus | null)[] = [
  null,
  'scheduled',
  'queued',
  'failed',
  'cancelled',
];
const CANCELLABLE: ScheduleStatus[] = ['scheduled', 'queued', 'failed'];
const RETRYABLE: ScheduleStatus[] = ['failed', 'completed'];

function lockHeld(row: ScheduleRow, now: Date): boolean {
  return (
    row.delivery_locked_at !== null &&
    now.getTime() - new Date(row.delivery_locked_at).getTime() < DELIVERY_LOCK_STALE_MS
  );
}

/** Best-effort removal of whatever triggers the row currently records. */
export async function deleteTriggers(
  backend: SchedulingBackend,
  row: Pick<ScheduleRow, 'scheduler_job_id' | 'cloud_task_id'>
): Promise<void> {
  const ops: Promise<void>[] = [];
  if (row.scheduler_job_id) ops.push(backend.deleteSchedulerJob(row.scheduler_job_id));
  if (row.cloud_task_id) ops.push(backend.deleteTask(row.cloud_task_id));
  const results = await Promise.allSettled(ops);
  for (const r of results) {
    if (r.status === 'rejected') {
      console.warn('[broadcast-scheduling] old trigger cleanup failed:', r.reason);
    }
  }
}

/**
 * Create the trigger for the row's current version: a Scheduler job at
 * T-lead, or — when the send is too close for that — the Cloud Task
 * directly. Records the outcome on the row.
 */
async function placeTrigger(
  db: SupabaseClient,
  backend: SchedulingBackend,
  cfg: SchedulingConfig,
  row: ScheduleRow,
  now: Date
): Promise<ScheduleResult> {
  const scheduledAt = new Date(row.scheduled_at!);
  const version = row.schedule_version;
  const base = {
    broadcastId: row.id,
    scheduledAt: scheduledAt.toISOString(),
    timezone: row.timezone,
    version,
  };

  if (scheduledAt.getTime() - now.getTime() <= cfg.leadMs + DIRECT_TASK_MARGIN_MS) {
    const payload: ExecutePayload = {
      broadcastId: row.id,
      version,
      pass: 0,
      trigger: 'schedule',
    };
    const taskName = await backend.createTask({
      taskId: cloudTaskId(row.id, version, 0),
      scheduleTime: scheduledAt > now ? scheduledAt : now,
      payload,
    });
    const updated = await updateIfVersion(
      db,
      row.id,
      version,
      {
        schedule_status: 'queued',
        cloud_task_id: taskName,
        scheduler_job_id: null,
        queued_at: now.toISOString(),
      },
      { statusIn: ['scheduled'] }
    );
    if (!updated) await backend.deleteTask(taskName).catch(() => {});
    return {
      ...base,
      scheduleStatus: 'queued',
      schedulerJobId: null,
      cloudTaskId: taskName,
      trigger: 'task',
    };
  }

  const armAt = computeArmTime(scheduledAt, cfg.leadMs);
  const payload: ArmPayload = { broadcastId: row.id, version };
  const jobName = await backend.createSchedulerJob({
    jobId: schedulerJobId(row.id, version),
    cron: schedulerCron(armAt, row.timezone),
    timeZone: row.timezone,
    description: `WACRM broadcast ${row.id} v${version} — sends ${utcToZonedLocal(scheduledAt, row.timezone)} ${row.timezone}`,
    payload,
  });
  await updateIfVersion(
    db,
    row.id,
    version,
    { scheduler_job_id: jobName, cloud_task_id: null },
    { statusIn: ['scheduled'] }
  );
  return {
    ...base,
    scheduleStatus: 'scheduled',
    schedulerJobId: jobName,
    cloudTaskId: null,
    trigger: 'scheduler',
  };
}

async function recordTriggerFailure(
  db: SupabaseClient,
  row: ScheduleRow,
  err: unknown
): Promise<never> {
  const message = err instanceof Error ? err.message : String(err);
  const now = new Date().toISOString();
  await updateIfVersion(db, row.id, row.schedule_version, {
    schedule_status: 'failed',
    last_error: `Could not create the Google Cloud trigger: ${message}`,
    last_error_at: now,
    failed_at: now,
  }).catch(() => {});
  throw new ScheduleError(
    'trigger_failed',
    `Could not create the Google Cloud trigger: ${message}`,
    502
  );
}

/**
 * Schedule a broadcast, or move an existing schedule. The broadcast
 * and its `pending` recipient rows must already exist.
 */
export async function scheduleBroadcast(
  db: SupabaseClient,
  backend: SchedulingBackend,
  cfg: SchedulingConfig,
  input: {
    accountId: string;
    broadcastId: string;
    scheduledAt: Date;
    timezone: string;
    now?: Date;
  }
): Promise<ScheduleResult> {
  const now = input.now ?? new Date();
  const { scheduledAt, timezone } = input;

  if (!isValidTimeZone(timezone)) {
    throw new ScheduleError('invalid_timezone', `Unknown time zone "${timezone}"`, 400);
  }
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new ScheduleError('invalid_time', 'scheduled_at is not a valid date', 400);
  }
  if (scheduledAt.getTime() < now.getTime() - PAST_TOLERANCE_MS) {
    throw new ScheduleError(
      'schedule_in_past',
      'The scheduled time is in the past. Pick a future time, or send now.',
      400
    );
  }
  if (scheduledAt.getTime() - now.getTime() > MAX_HORIZON_MS) {
    throw new ScheduleError(
      'schedule_too_far',
      'Broadcasts can be scheduled at most 364 days ahead.',
      400
    );
  }

  const row = await loadScheduleRow(db, input.broadcastId, input.accountId);
  if (!row) throw new ScheduleError('not_found', 'Broadcast not found', 404);

  if (!RESCHEDULABLE.includes(row.schedule_status)) {
    throw new ScheduleError(
      'not_reschedulable',
      `This broadcast is ${row.schedule_status} and can no longer be rescheduled.`,
      409
    );
  }
  if (row.schedule_status === null && !['scheduled', 'draft'].includes(row.status)) {
    throw new ScheduleError(
      'not_reschedulable',
      `A broadcast that is already ${row.status} can't be scheduled.`,
      409
    );
  }
  if (lockHeld(row, now)) {
    throw new ScheduleError('busy', 'A delivery pass is running for this broadcast.', 409);
  }
  if ((await countRecipients(db, row.id, 'pending')) === 0) {
    throw new ScheduleError(
      'no_pending_recipients',
      'This broadcast has no pending recipients to send to.',
      400
    );
  }

  const bumped = await updateIfVersion(
    db,
    row.id,
    row.schedule_version,
    {
      schedule_version: row.schedule_version + 1,
      schedule_status: 'scheduled',
      status: 'scheduled',
      scheduled_at: scheduledAt.toISOString(),
      timezone,
      scheduler_job_id: null,
      cloud_task_id: null,
      queued_at: null,
      cancelled_at: null,
      failed_at: null,
      last_error: null,
      last_error_at: null,
    },
    { statusIn: RESCHEDULABLE }
  );
  if (!bumped) {
    throw new ScheduleError(
      'conflict',
      'The broadcast changed while scheduling. Reload and try again.',
      409
    );
  }

  await deleteTriggers(backend, row);

  try {
    return await placeTrigger(db, backend, cfg, bumped, now);
  } catch (err) {
    return recordTriggerFailure(db, bumped, err);
  }
}

export async function cancelBroadcastSchedule(
  db: SupabaseClient,
  backend: SchedulingBackend,
  input: { accountId: string; broadcastId: string; now?: Date }
): Promise<{ broadcastId: string; version: number }> {
  const now = input.now ?? new Date();
  const row = await loadScheduleRow(db, input.broadcastId, input.accountId);
  if (!row) throw new ScheduleError('not_found', 'Broadcast not found', 404);

  if (!row.schedule_status || !CANCELLABLE.includes(row.schedule_status)) {
    throw new ScheduleError(
      'not_cancellable',
      row.schedule_status === 'processing'
        ? 'This broadcast is already sending and can no longer be cancelled.'
        : 'This broadcast has no active schedule to cancel.',
      409
    );
  }

  const updated = await updateIfVersion(
    db,
    row.id,
    row.schedule_version,
    {
      schedule_version: row.schedule_version + 1,
      schedule_status: 'cancelled',
      status: 'cancelled',
      cancelled_at: now.toISOString(),
      scheduler_job_id: null,
      cloud_task_id: null,
    },
    { statusIn: CANCELLABLE }
  );
  if (!updated) {
    throw new ScheduleError(
      'conflict',
      'The broadcast started sending or changed while cancelling. Reload to see its state.',
      409
    );
  }

  await deleteTriggers(backend, row);
  return { broadcastId: row.id, version: updated.schedule_version };
}

export type RetryScope = 'pending' | 'failed' | 'all';

/**
 * Re-run a failed (or completed-with-failures) scheduled broadcast now,
 * through Cloud Tasks. `failed`/`all` first return failed recipients
 * to `pending`.
 */
export async function retryScheduledBroadcast(
  db: SupabaseClient,
  backend: SchedulingBackend,
  input: { accountId: string; broadcastId: string; scope: RetryScope; now?: Date }
): Promise<{ broadcastId: string; version: number; cloudTaskId: string; recipients: number }> {
  const now = input.now ?? new Date();
  const row = await loadScheduleRow(db, input.broadcastId, input.accountId);
  if (!row) throw new ScheduleError('not_found', 'Broadcast not found', 404);

  if (!row.schedule_status || !RETRYABLE.includes(row.schedule_status)) {
    throw new ScheduleError(
      'not_retryable',
      'Only a failed or completed scheduled broadcast can be retried.',
      409
    );
  }
  if (lockHeld(row, now)) {
    throw new ScheduleError('busy', 'A delivery pass is running for this broadcast.', 409);
  }

  const pending = await countRecipients(db, row.id, 'pending');
  const failed = input.scope === 'pending' ? 0 : await countRecipients(db, row.id, 'failed');
  if (pending + failed === 0) {
    throw new ScheduleError('nothing_to_retry', 'There are no recipients left to retry.', 400);
  }

  const bumped = await updateIfVersion(
    db,
    row.id,
    row.schedule_version,
    {
      schedule_version: row.schedule_version + 1,
      schedule_status: 'queued',
      status: 'scheduled',
      queued_at: now.toISOString(),
      scheduler_job_id: null,
      cloud_task_id: null,
      failed_at: null,
      completed_at: null,
      last_error: null,
      last_error_at: null,
    },
    { statusIn: RETRYABLE }
  );
  if (!bumped) {
    throw new ScheduleError('conflict', 'The broadcast changed while retrying. Reload and try again.', 409);
  }

  if (input.scope !== 'pending') {
    const { error } = await db
      .from('broadcast_recipients')
      .update({ status: 'pending', error_message: null })
      .eq('broadcast_id', row.id)
      .eq('status', 'failed');
    if (error) {
      await recordTriggerFailure(db, bumped, new Error(`resetting failed recipients: ${error.message}`));
    }
  }

  const payload: ExecutePayload = {
    broadcastId: row.id,
    version: bumped.schedule_version,
    pass: 0,
    trigger: 'retry',
  };
  let taskName: string;
  try {
    taskName = await backend.createTask({
      taskId: cloudTaskId(row.id, bumped.schedule_version, 0),
      scheduleTime: now,
      payload,
    });
  } catch (err) {
    return recordTriggerFailure(db, bumped, err);
  }
  await updateIfVersion(db, row.id, bumped.schedule_version, { cloud_task_id: taskName });

  return {
    broadcastId: row.id,
    version: bumped.schedule_version,
    cloudTaskId: taskName,
    recipients: pending + failed,
  };
}
