-- ============================================================
-- 096: Backup (fallback) AI provider for the AI agent.
--
-- The primary model (e.g. a free key) answers first; if it fails — quota
-- exhausted, rate-limited, invalid key, timeout, provider error — the
-- same request is retried at once on the backup (e.g. a paid key), so the
-- customer still gets a reply and the paid key is only spent when needed.
-- The backup key is stored AES-256-GCM-encrypted like the main key.
-- Additive; nothing changes until a backup is set. Idempotent.
-- ============================================================

ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS fallback_enabled  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS fallback_provider TEXT;
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS fallback_model    TEXT;
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS fallback_base_url TEXT;
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS fallback_api_key  TEXT;
