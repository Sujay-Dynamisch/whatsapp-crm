-- ============================================================
-- 048_smart_sending
--
-- Delivery protection for broadcasts (feature 'smart_sending'):
--
--   1. Engagement signals on contacts, maintained by triggers so every
--      path (webhook, wizard, workers) feeds them:
--        last_engaged_at      reply / button click / inbound message
--        last_read_at         a broadcast was read
--        unread_streak        broadcasts delivered but not read, in a row
--        meta_limited_count / last_meta_limited_at
--                             Meta error 131049 (per-user marketing limit)
--        activity_hours[24]   reads + inbound messages per UTC hour —
--                             drives "best time to send"
--      The score/tier itself is computed in the app from these
--      (src/lib/smart-sending/engagement.ts) so it never goes stale.
--
--   2. Automatic one-time retry of 131049 failures: a trigger stamps
--      broadcast_recipients.retry_at when the failure arrives; the
--      reconciler claims due rows with claim_limited_retries().
--
--   3. Smart timing: broadcast_recipients.send_after holds each
--      recipient's personal send time; broadcasts.next_pass_at tells the
--      reconciler when the next timed batch is due.
--
--   4. Quality-rating guard: the WhatsApp number's quality rating and
--      messaging tier, cached on whatsapp_config.
--
--   5. Per-account settings (delivery_settings).
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- Columns
-- ------------------------------------------------------------
ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS error_code  INTEGER,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retry_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS send_after  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_retry_at
  ON broadcast_recipients (retry_at) WHERE retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_contact
  ON broadcast_recipients (contact_id);

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS smart_timing BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS next_pass_at TIMESTAMPTZ;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS last_engaged_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_read_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unread_streak        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS meta_limited_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_meta_limited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activity_hours       INTEGER[] NOT NULL DEFAULT array_fill(0, ARRAY[24]);

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS quality_rating       TEXT,
  ADD COLUMN IF NOT EXISTS messaging_limit_tier TEXT,
  ADD COLUMN IF NOT EXISTS quality_checked_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quality_event        TEXT,
  ADD COLUMN IF NOT EXISTS quality_event_at     TIMESTAMPTZ;

-- ------------------------------------------------------------
-- Settings
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delivery_settings (
  account_id          UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  auto_retry_limited  BOOLEAN NOT NULL DEFAULT true,
  retry_delay_hours   INTEGER NOT NULL DEFAULT 24 CHECK (retry_delay_hours BETWEEN 12 AND 72),
  rest_days           INTEGER NOT NULL DEFAULT 7  CHECK (rest_days BETWEEN 1 AND 60),
  rest_after_unread   INTEGER NOT NULL DEFAULT 5  CHECK (rest_after_unread BETWEEN 2 AND 20),
  quality_guard       BOOLEAN NOT NULL DEFAULT true,
  yellow_pass_size    INTEGER NOT NULL DEFAULT 100 CHECK (yellow_pass_size BETWEEN 10 AND 1000),
  updated_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE delivery_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_settings_select ON delivery_settings;
CREATE POLICY delivery_settings_select ON delivery_settings FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS delivery_settings_insert ON delivery_settings;
CREATE POLICY delivery_settings_insert ON delivery_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS delivery_settings_update ON delivery_settings;
CREATE POLICY delivery_settings_update ON delivery_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS feature_gate_insert ON delivery_settings;
CREATE POLICY feature_gate_insert ON delivery_settings AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.account_has_feature(account_id, 'smart_sending'));
DROP POLICY IF EXISTS feature_gate_update ON delivery_settings;
CREATE POLICY feature_gate_update ON delivery_settings AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.account_has_feature(account_id, 'smart_sending'));

DROP TRIGGER IF EXISTS set_updated_at ON delivery_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON delivery_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- Helpers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bump_activity_hour(p_hours INTEGER[], p_at TIMESTAMPTZ)
RETURNS INTEGER[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v INTEGER[] := COALESCE(p_hours, array_fill(0, ARRAY[24]));
  i INTEGER := EXTRACT(HOUR FROM (p_at AT TIME ZONE 'UTC'))::INTEGER + 1;
BEGIN
  IF array_length(v, 1) IS DISTINCT FROM 24 THEN
    v := array_fill(0, ARRAY[24]);
  END IF;
  v[i] := COALESCE(v[i], 0) + 1;
  RETURN v;
END;
$$;

-- ------------------------------------------------------------
-- 131049 → schedule the one automatic retry
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.schedule_limited_retry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_auto BOOLEAN;
  v_delay INTEGER;
BEGIN
  IF NEW.status = 'failed'
     AND OLD.status IS DISTINCT FROM 'failed'
     AND NEW.error_code = 131049
     AND NEW.retry_count = 0
     AND NEW.retry_at IS NULL
  THEN
    SELECT b.account_id, COALESCE(s.auto_retry_limited, true), COALESCE(s.retry_delay_hours, 24)
      INTO v_account, v_auto, v_delay
    FROM broadcasts b
    LEFT JOIN delivery_settings s ON s.account_id = b.account_id
    WHERE b.id = NEW.broadcast_id;

    IF v_auto AND public.account_has_feature(v_account, 'smart_sending') THEN
      NEW.retry_at := NOW() + make_interval(hours => v_delay);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS schedule_limited_retry ON broadcast_recipients;
CREATE TRIGGER schedule_limited_retry
  BEFORE UPDATE OF status ON broadcast_recipients
  FOR EACH ROW EXECUTE FUNCTION public.schedule_limited_retry();

-- ------------------------------------------------------------
-- Engagement signals
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.track_recipient_engagement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_read_at TIMESTAMPTZ;
BEGIN
  IF NEW.contact_id IS NULL OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'delivered' AND OLD.status IN ('pending', 'sent') THEN
    UPDATE contacts SET unread_streak = unread_streak + 1 WHERE id = NEW.contact_id;

  ELSIF NEW.status IN ('read', 'replied') AND OLD.status NOT IN ('read', 'replied') THEN
    v_read_at := COALESCE(NEW.read_at, NOW());
    UPDATE contacts
    SET unread_streak  = 0,
        last_read_at   = GREATEST(COALESCE(last_read_at, '-infinity'::timestamptz), v_read_at),
        activity_hours = public.bump_activity_hour(activity_hours, v_read_at),
        last_engaged_at = CASE WHEN NEW.status = 'replied'
                               THEN GREATEST(COALESCE(last_engaged_at, '-infinity'::timestamptz), NOW())
                               ELSE last_engaged_at END
    WHERE id = NEW.contact_id;

  ELSIF NEW.status = 'replied' THEN
    UPDATE contacts
    SET last_engaged_at = GREATEST(COALESCE(last_engaged_at, '-infinity'::timestamptz), NOW())
    WHERE id = NEW.contact_id;

  ELSIF NEW.status = 'failed' AND NEW.error_code = 131049 THEN
    UPDATE contacts
    SET meta_limited_count = meta_limited_count + 1,
        last_meta_limited_at = NOW()
    WHERE id = NEW.contact_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS track_recipient_engagement ON broadcast_recipients;
CREATE TRIGGER track_recipient_engagement
  AFTER UPDATE OF status ON broadcast_recipients
  FOR EACH ROW EXECUTE FUNCTION public.track_recipient_engagement();

CREATE OR REPLACE FUNCTION public.track_inbound_engagement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_at TIMESTAMPTZ := COALESCE(NEW.created_at, NOW());
BEGIN
  IF NEW.sender_type = 'customer' THEN
    UPDATE contacts c
    SET unread_streak = 0,
        last_engaged_at = GREATEST(COALESCE(c.last_engaged_at, '-infinity'::timestamptz), v_at),
        activity_hours = public.bump_activity_hour(c.activity_hours, v_at)
    FROM conversations cv
    WHERE cv.id = NEW.conversation_id AND c.id = cv.contact_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS track_inbound_engagement ON messages;
CREATE TRIGGER track_inbound_engagement
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.track_inbound_engagement();

CREATE OR REPLACE FUNCTION public.track_click_engagement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.contact_id IS NOT NULL THEN
    UPDATE contacts
    SET unread_streak = 0,
        last_engaged_at = GREATEST(COALESCE(last_engaged_at, '-infinity'::timestamptz), NEW.clicked_at)
    WHERE id = NEW.contact_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS track_click_engagement ON button_clicks;
CREATE TRIGGER track_click_engagement
  AFTER INSERT ON button_clicks
  FOR EACH ROW EXECUTE FUNCTION public.track_click_engagement();

-- Backfill from history (best effort, last 90 days).
UPDATE contacts c SET last_engaged_at = x.at
FROM (
  SELECT cv.contact_id, MAX(m.created_at) AS at
  FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
  WHERE m.sender_type = 'customer' AND m.created_at > NOW() - INTERVAL '90 days'
  GROUP BY cv.contact_id
) x
WHERE x.contact_id = c.id AND c.last_engaged_at IS NULL;

UPDATE contacts c SET last_read_at = x.at
FROM (
  SELECT contact_id, MAX(read_at) AS at
  FROM broadcast_recipients
  WHERE read_at IS NOT NULL AND read_at > NOW() - INTERVAL '90 days'
  GROUP BY contact_id
) x
WHERE x.contact_id = c.id AND c.last_read_at IS NULL;

-- ------------------------------------------------------------
-- Retry claim (service role only)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_limited_retries(p_limit INTEGER DEFAULT 200)
RETURNS TABLE(recipient_id UUID, broadcast_id UUID, account_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT r.id
    FROM broadcast_recipients r
    JOIN broadcasts b ON b.id = r.broadcast_id
    WHERE r.retry_at IS NOT NULL
      AND r.retry_at <= NOW()
      AND r.status = 'failed'
      AND r.retry_count = 0
      AND public.account_has_feature(b.account_id, 'smart_sending')
    ORDER BY r.retry_at
    LIMIT p_limit
    FOR UPDATE OF r SKIP LOCKED
  )
  UPDATE broadcast_recipients r
  SET status = 'pending',
      retry_count = r.retry_count + 1,
      retry_at = NULL,
      error_code = NULL,
      error_message = NULL
  FROM due, broadcasts b
  WHERE r.id = due.id AND b.id = r.broadcast_id
  RETURNING r.id, r.broadcast_id, b.account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_limited_retries(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_limited_retries(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.claim_limited_retries(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_limited_retries(INTEGER) TO service_role;
