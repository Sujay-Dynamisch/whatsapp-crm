-- ============================================================
-- 060: Failed messages page + health alerts (feature 'failed_messages').
--
--   1. Follow-up state on failed sends, so a failure can be resent now,
--      scheduled for later, replaced by a custom text, or dismissed:
--        journey_messages.resolved (new values) / resolved_at / manual_retry_at
--        messages.failure_resolved / failure_resolved_at / manual_retry_at
--   2. lead_sync_issues — website registrations skipped by the lead sync
--      (invalid phone number), once per registration, to fix by hand.
--   3. system_heartbeats — when the every-minute journeyTick last ran,
--      so the app can warn when the scheduler stops.
--   4. health_summaries — one daily summary per account (claim row).
--   5. notifications learn 'health_alert' and 'health_summary'.
--   6. 'failed_messages' is OFF by default: switched off for existing
--      accounts and for new ones; the system admin turns it on per
--      account (Admin → Accounts → Features).
--
-- Idempotent — safe to re-run.
-- ============================================================

-- 1. Follow-up state -------------------------------------------------
ALTER TABLE journey_messages ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE journey_messages ADD COLUMN IF NOT EXISTS manual_retry_at TIMESTAMPTZ;
ALTER TABLE journey_messages DROP CONSTRAINT IF EXISTS journey_messages_resolved_check;
ALTER TABLE journey_messages ADD CONSTRAINT journey_messages_resolved_check
  CHECK (resolved IN ('retried', 'fallback_sent', 'expired', 'superseded', 'opted_out', 'resent', 'custom_text', 'dismissed'));

ALTER TABLE messages ADD COLUMN IF NOT EXISTS failure_resolved TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS failure_resolved_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS manual_retry_at TIMESTAMPTZ;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_failure_resolved_check;
ALTER TABLE messages ADD CONSTRAINT messages_failure_resolved_check
  CHECK (failure_resolved IS NULL OR failure_resolved IN ('resent', 'custom_text', 'dismissed'));

CREATE INDEX IF NOT EXISTS idx_journey_messages_failed_day
  ON journey_messages (account_id, created_at) WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS idx_journey_messages_manual_retry
  ON journey_messages (manual_retry_at) WHERE manual_retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_failed_day
  ON messages (created_at) WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS idx_messages_manual_retry
  ON messages (manual_retry_at) WHERE manual_retry_at IS NOT NULL;

-- 2. Skipped registrations --------------------------------------------
CREATE TABLE IF NOT EXISTS lead_sync_issues (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  registration_id TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'invalid_phone' CHECK (kind IN ('invalid_phone')),
  raw_phone       TEXT,
  name            TEXT,
  email           TEXT,
  city            TEXT,
  registered_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Fixed by hand (contact added) or dismissed.
  resolved        TEXT CHECK (resolved IS NULL OR resolved IN ('added', 'dismissed')),
  resolved_at     TIMESTAMPTZ,
  contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
  UNIQUE (account_id, registration_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_lead_sync_issues_account_time ON lead_sync_issues (account_id, created_at DESC);

ALTER TABLE lead_sync_issues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_sync_issues_select ON lead_sync_issues;
CREATE POLICY lead_sync_issues_select ON lead_sync_issues FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS feature_gate_select ON lead_sync_issues;
CREATE POLICY feature_gate_select ON lead_sync_issues AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.account_has_feature(account_id, 'failed_messages'));
-- Writes go through the API (service role) after a membership check.

-- 3. Scheduler heartbeat ----------------------------------------------
CREATE TABLE IF NOT EXISTS system_heartbeats (
  name       TEXT PRIMARY KEY,
  last_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  report     JSONB
);
ALTER TABLE system_heartbeats ENABLE ROW LEVEL SECURITY;
-- No tenant data in here: any signed-in user may read when it last ran.
DROP POLICY IF EXISTS system_heartbeats_select ON system_heartbeats;
CREATE POLICY system_heartbeats_select ON system_heartbeats FOR SELECT TO authenticated USING (true);

-- 4. Daily summary claim ----------------------------------------------
CREATE TABLE IF NOT EXISTS health_summaries (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  summary    JSONB,
  PRIMARY KEY (account_id, day)
);
ALTER TABLE health_summaries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS health_summaries_select ON health_summaries;
CREATE POLICY health_summaries_select ON health_summaries FOR SELECT
  USING (is_account_member(account_id));

-- 5. Notification types -----------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'callback_requested', 'callback_overdue', 'callback_returned', 'health_alert', 'health_summary'));

-- 6. Off by default ---------------------------------------------------
UPDATE accounts
SET disabled_features = array_append(disabled_features, 'failed_messages')
WHERE NOT ('failed_messages' = ANY (disabled_features));

-- New accounts start with it off. Runs after
-- enforce_account_features_admin_only (triggers fire in name order), so
-- that guard still sees what the client sent.
CREATE OR REPLACE FUNCTION public.accounts_default_off_features()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT ('failed_messages' = ANY (NEW.disabled_features)) THEN
    NEW.disabled_features := array_append(NEW.disabled_features, 'failed_messages');
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.accounts_default_off_features() OWNER TO postgres;

DROP TRIGGER IF EXISTS zz_accounts_default_off_features ON public.accounts;
CREATE TRIGGER zz_accounts_default_off_features
  BEFORE INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.accounts_default_off_features();
