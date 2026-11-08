-- ============================================================
-- 043_scheduled_broadcasts
--
-- Server-side scheduled broadcasts, driven by Google Cloud:
--
--   Supabase row (schedule_status 'scheduled')
--     → Cloud Scheduler job fires at T-2 min      (armBroadcast)
--     → Cloud Task dispatched at exactly T         (executeBroadcast)
--     → WhatsApp Cloud API
--     → this row: 'processing' → 'completed' | 'failed'
--
-- Supabase stays the source of truth. Every Google-side trigger
-- carries the `schedule_version` it was created for; any trigger whose
-- version no longer matches the row is a no-op. That one integer is
-- what makes reschedule and cancel safe without having to guarantee
-- that the old job/task was actually deleted.
--
-- `broadcasts.status` keeps its existing meaning for the UI
-- (scheduled → sending → sent | failed) and gains 'cancelled'.
-- `schedule_status` is the pipeline state of the scheduling layer and
-- is NULL for broadcasts that were sent immediately.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Allow 'cancelled' as a broadcast status
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_status_check' AND conrelid = 'broadcasts'::regclass
  ) THEN
    ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_status_check;
  END IF;
END $$;

ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'));

-- ============================================================
-- 2. Scheduling columns
-- ============================================================
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS timezone             TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN IF NOT EXISTS template_id          UUID REFERENCES message_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS schedule_status      TEXT,
  ADD COLUMN IF NOT EXISTS schedule_version     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scheduler_job_id     TEXT,
  ADD COLUMN IF NOT EXISTS cloud_task_id        TEXT,
  ADD COLUMN IF NOT EXISTS queued_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_attempts   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error           TEXT,
  ADD COLUMN IF NOT EXISTS last_error_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_result     JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_schedule_status_check' AND conrelid = 'broadcasts'::regclass
  ) THEN
    ALTER TABLE broadcasts
      ADD CONSTRAINT broadcasts_schedule_status_check
      CHECK (schedule_status IS NULL OR schedule_status IN (
        'scheduled', 'queued', 'processing', 'completed', 'failed', 'cancelled'
      ));
  END IF;
END $$;

COMMENT ON COLUMN broadcasts.timezone IS
  'IANA zone the user scheduled in (default Asia/Kolkata). scheduled_at is always stored as an absolute instant; this is for display and the Cloud Scheduler job.';
COMMENT ON COLUMN broadcasts.schedule_status IS
  'Scheduling-layer state: scheduled (Cloud Scheduler job armed) → queued (Cloud Task created) → processing → completed | failed; or cancelled. NULL for immediate sends. See 043_scheduled_broadcasts.sql.';
COMMENT ON COLUMN broadcasts.schedule_version IS
  'Bumped on every schedule / reschedule / cancel / retry. Google-side triggers carry the version they were created for and no-op on mismatch.';
COMMENT ON COLUMN broadcasts.scheduler_job_id IS
  'Full Cloud Scheduler job name for the current version (NULL once armed or when the trigger went straight to Cloud Tasks).';
COMMENT ON COLUMN broadcasts.cloud_task_id IS
  'Full Cloud Tasks task name for the current version''s first delivery pass.';
COMMENT ON COLUMN broadcasts.execution_result IS
  'Summary of the latest execution: { total, sent, failed, pending, passes, updated_at }. Per-recipient results live on broadcast_recipients.';

-- The reconciler sweeps by (schedule_status, scheduled_at).
CREATE INDEX IF NOT EXISTS idx_broadcasts_schedule_status_scheduled_at
  ON broadcasts (schedule_status, scheduled_at)
  WHERE schedule_status IS NOT NULL;

-- ============================================================
-- 3. Per-recipient structured send params
--
-- 038 froze the positional body params. Header media URL and
-- carousel/button values were still only known to the browser tab,
-- so a server-side send (resume, and now every scheduled send) fell
-- back to the template's stored sample media. Freezing the full
-- SendTimeParams object here makes the server send identical to the
-- wizard's.
-- ============================================================
ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS message_params JSONB;

COMMENT ON COLUMN broadcast_recipients.message_params IS
  'Structured SendTimeParams (header media URL, carousel card / button values) frozen at plan time. NULL on rows created before migration 043.';
