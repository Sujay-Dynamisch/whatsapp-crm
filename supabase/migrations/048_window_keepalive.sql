-- ============================================================
-- 044_window_keepalive
--
-- WhatsApp only allows free-form (non-template) messages within 24
-- hours of the customer's last message — the "customer service
-- window". Keep-alive sends ONE short check-in shortly before that
-- window closes, so a customer who replies re-opens it for another
-- 24 hours.
--
--   1. conversations.last_customer_message_at — when the current
--      window opened. Maintained by a trigger on `messages`, so every
--      inbound path (webhook, imports, future channels) is covered
--      without touching the webhook.
--   2. conversations.window_keepalive_for — the window a keep-alive
--      was already sent for. One nudge per customer message, ever:
--      there is no way to loop, because only a customer reply opens a
--      new window.
--   3. window_keepalive_settings — per-account switch, timing, text.
--   4. claim_window_keepalives() — atomically picks the due
--      conversations and marks them claimed in one statement, so
--      overlapping sweeps can never nudge the same window twice.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1–2. Conversation columns + trigger
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS window_keepalive_for     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS window_keepalive_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN conversations.last_customer_message_at IS
  'Time of the latest customer (inbound) message — the start of the current 24h WhatsApp customer-service window. Trigger-maintained (044).';
COMMENT ON COLUMN conversations.window_keepalive_for IS
  'The last_customer_message_at value a keep-alive was claimed for. Equal to last_customer_message_at means this window has had its one nudge.';

CREATE OR REPLACE FUNCTION public.track_last_customer_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sender_type = 'customer' THEN
    UPDATE conversations
    SET last_customer_message_at = GREATEST(
          COALESCE(last_customer_message_at, '-infinity'::timestamptz),
          COALESCE(NEW.created_at, NOW())
        )
    WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS track_last_customer_message ON messages;
CREATE TRIGGER track_last_customer_message
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.track_last_customer_message();

-- Backfill from history so open windows are covered from day one.
UPDATE conversations c
SET last_customer_message_at = m.latest
FROM (
  SELECT conversation_id, MAX(created_at) AS latest
  FROM messages
  WHERE sender_type = 'customer'
  GROUP BY conversation_id
) m
WHERE m.conversation_id = c.id
  AND c.last_customer_message_at IS DISTINCT FROM m.latest;

-- The sweep scans by window start.
CREATE INDEX IF NOT EXISTS idx_conversations_last_customer_message_at
  ON conversations (last_customer_message_at)
  WHERE last_customer_message_at IS NOT NULL;

-- ============================================================
-- 3. Per-account settings
-- ============================================================
CREATE TABLE IF NOT EXISTS window_keepalive_settings (
  account_id     UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled        BOOLEAN NOT NULL DEFAULT false,
  -- How long before the window closes to send. 60 → at hour 23.
  lead_minutes   INTEGER NOT NULL DEFAULT 60 CHECK (lead_minutes BETWEEN 15 AND 240),
  -- Skip if anyone (agent, bot) messaged the customer this recently —
  -- that message already serves as the nudge.
  quiet_minutes  INTEGER NOT NULL DEFAULT 30 CHECK (quiet_minutes BETWEEN 0 AND 240),
  message_text   TEXT NOT NULL DEFAULT 'Hi! Just checking in — is there anything else we can help you with? Reply here and we''ll be happy to assist.'
                 CHECK (char_length(message_text) BETWEEN 1 AND 1000),
  updated_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE window_keepalive_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS window_keepalive_settings_select ON window_keepalive_settings;
CREATE POLICY window_keepalive_settings_select ON window_keepalive_settings FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS window_keepalive_settings_insert ON window_keepalive_settings;
CREATE POLICY window_keepalive_settings_insert ON window_keepalive_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS window_keepalive_settings_update ON window_keepalive_settings;
CREATE POLICY window_keepalive_settings_update ON window_keepalive_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON window_keepalive_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON window_keepalive_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 4. Atomic claim
--
-- A conversation is due when its window:
--   - opened at least (24h - lead) ago            → we're in the send slot
--   - still has more than 5 minutes left           → Meta will accept it
--   - hasn't had a keep-alive yet                  → once per window
-- and the conversation isn't closed, nobody messaged in the last
-- quiet_minutes, and the contact isn't tagged 'unsubscribe'.
--
-- Claimed rows are stamped in the same UPDATE (FOR UPDATE SKIP LOCKED
-- lets concurrent sweeps divide the work instead of colliding).
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_window_keepalives(p_limit INTEGER DEFAULT 100)
RETURNS TABLE(
  conversation_id UUID,
  account_id UUID,
  contact_id UUID,
  window_opened_at TIMESTAMPTZ,
  message_text TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT c.id, s.message_text AS text
    FROM conversations c
    JOIN window_keepalive_settings s ON s.account_id = c.account_id AND s.enabled
    WHERE c.last_customer_message_at IS NOT NULL
      AND c.last_customer_message_at <= NOW() - INTERVAL '24 hours' + make_interval(mins => s.lead_minutes)
      AND c.last_customer_message_at >  NOW() - INTERVAL '24 hours' + INTERVAL '5 minutes'
      AND c.window_keepalive_for IS DISTINCT FROM c.last_customer_message_at
      AND c.status <> 'closed'
      AND (c.last_message_at IS NULL
           OR c.last_message_at < NOW() - make_interval(mins => s.quiet_minutes))
      AND NOT EXISTS (
        SELECT 1
        FROM contact_tags ct
        JOIN tags t ON t.id = ct.tag_id
        WHERE ct.contact_id = c.contact_id
          AND lower(t.name) = 'unsubscribe'
      )
    ORDER BY c.last_customer_message_at
    LIMIT p_limit
    FOR UPDATE OF c SKIP LOCKED
  )
  UPDATE conversations c
  SET window_keepalive_for = c.last_customer_message_at
  FROM due
  WHERE c.id = due.id
  RETURNING c.id, c.account_id, c.contact_id, c.last_customer_message_at, due.text;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_window_keepalives(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_window_keepalives(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.claim_window_keepalives(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_window_keepalives(INTEGER) TO service_role;
