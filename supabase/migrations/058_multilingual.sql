-- ============================================================
-- 049_multilingual
--
-- Inbox translation and voice-note transcription
-- (features 'translation' and 'voice_transcription', both under
-- 'ai_agents'):
--
--   messages.detected_language   ISO 639-1 of an inbound message
--   messages.translated_text     inbound text in the agents' language
--   messages.original_text       outbound: what the agent typed before
--                                it was translated for the customer
--   messages.transcript / transcript_summary / transcript_status
--                                voice notes (Whisper)
--   conversations.customer_language
--                                last detected customer language —
--                                drives "Translate to …" in the composer
--   language_settings            per account
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS detected_language  TEXT,
  ADD COLUMN IF NOT EXISTS translated_text    TEXT,
  ADD COLUMN IF NOT EXISTS original_text      TEXT,
  ADD COLUMN IF NOT EXISTS transcript         TEXT,
  ADD COLUMN IF NOT EXISTS transcript_summary TEXT,
  ADD COLUMN IF NOT EXISTS transcript_status  TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_transcript_status_check' AND conrelid = 'messages'::regclass
  ) THEN
    ALTER TABLE messages ADD CONSTRAINT messages_transcript_status_check
      CHECK (transcript_status IS NULL OR transcript_status IN ('done', 'failed', 'skipped'));
  END IF;
END $$;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS customer_language TEXT;

CREATE TABLE IF NOT EXISTS language_settings (
  account_id             UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  agent_language         TEXT NOT NULL DEFAULT 'en',
  translate_inbound      BOOLEAN NOT NULL DEFAULT true,
  transcribe_voice       BOOLEAN NOT NULL DEFAULT true,
  summarize_voice        BOOLEAN NOT NULL DEFAULT true,
  -- 'auto' reuses the AI agent's key when its provider has Whisper
  -- (OpenAI, Groq); otherwise transcription_api_key is used.
  transcription_provider TEXT NOT NULL DEFAULT 'auto'
                         CHECK (transcription_provider IN ('auto', 'openai', 'groq')),
  transcription_api_key  TEXT,  -- AES-256-GCM encrypted, like ai_configs.api_key
  updated_by             UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE language_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS language_settings_select ON language_settings;
CREATE POLICY language_settings_select ON language_settings FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS language_settings_insert ON language_settings;
CREATE POLICY language_settings_insert ON language_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS language_settings_update ON language_settings;
CREATE POLICY language_settings_update ON language_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS feature_gate_insert ON language_settings;
CREATE POLICY feature_gate_insert ON language_settings AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.account_has_feature(account_id, 'ai_agents'));
DROP POLICY IF EXISTS feature_gate_update ON language_settings;
CREATE POLICY feature_gate_update ON language_settings AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.account_has_feature(account_id, 'ai_agents'));

DROP TRIGGER IF EXISTS set_updated_at ON language_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON language_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- transcription_api_key is AES-256-GCM encrypted with the server-only
-- ENCRYPTION_KEY (same as ai_configs.api_key), and the settings API
-- never returns it — only whether one is set.
