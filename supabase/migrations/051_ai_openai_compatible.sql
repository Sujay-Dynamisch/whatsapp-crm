-- ============================================================
-- 046_ai_openai_compatible.sql — configurable OpenAI-compatible chat APIs
--
-- Fork note: the provider CHECKs also list the catalogue providers
-- (047_ai_providers) so this applies on a database that already has
-- gemini / groq / … rows. 066 sets the final list.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS base_url text;

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN (
    'openai', 'anthropic', 'gemini', 'groq', 'openrouter',
    'xai', 'mistral', 'deepseek', 'cerebras', 'openai_compatible'
  ));

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_openai_compatible_base_url_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_openai_compatible_base_url_check
  CHECK (
    provider <> 'openai_compatible'
    OR (base_url IS NOT NULL AND btrim(base_url) <> '')
  );

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN (
    'openai', 'anthropic', 'gemini', 'groq', 'openrouter',
    'xai', 'mistral', 'deepseek', 'cerebras', 'openai_compatible'
  ));
