-- ============================================================
-- 059: callback follow-ups — what happens when a callback doesn't work out.
--
--   * no_answer_count — how many times the team marked "No answer". The
--     app sends a "we tried calling you" message, and after the limit
--     (journey trigger setting, default 2) puts the lead back into the
--     journey's nurture.
--   * reminded_at — when the owner/admins were reminded that a request
--     is still waiting for a call (journeyTick, after 4 hours).
--   * notifications learn 'callback_overdue' (the reminder) and
--     'callback_returned' (a lead went back to nurture automatically).
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS no_answer_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;

-- Reminder scan: open, never-called requests by age.
CREATE INDEX IF NOT EXISTS idx_callback_requests_waiting
  ON callback_requests (requested_at) WHERE status = 'new' AND reminded_at IS NULL;
-- Stale "No answer" scan.
CREATE INDEX IF NOT EXISTS idx_callback_requests_no_answer
  ON callback_requests (handled_at) WHERE status = 'no_answer';

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'callback_requested', 'callback_overdue', 'callback_returned'));
