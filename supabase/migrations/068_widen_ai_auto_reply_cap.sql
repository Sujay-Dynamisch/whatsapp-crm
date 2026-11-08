-- ============================================================
-- 068_widen_ai_auto_reply_cap.sql
--
-- Widen the AI auto-reply cap from max 20 to 100, set default to 20,
-- and upgrade existing accounts currently on the old default (3)
-- to 20 so AI agents don't prematurely stop replying.
-- ============================================================

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_auto_reply_max_per_conversation_check;

ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_auto_reply_max_per_conversation_check
  CHECK (auto_reply_max_per_conversation BETWEEN 1 AND 100);

ALTER TABLE ai_configs ALTER COLUMN auto_reply_max_per_conversation SET DEFAULT 20;

-- Bump accounts that were on the old conservative default of 3
UPDATE ai_configs
SET auto_reply_max_per_conversation = 20
WHERE auto_reply_max_per_conversation = 3;

