-- ============================================================
-- 066: final AI provider list = the catalogue providers (047) plus the
-- custom 'openai_compatible' endpoint (upstream 046, which also adds
-- ai_configs.base_url). 047 runs after 046 and would otherwise drop
-- 'openai_compatible' again. Keys must match
-- src/lib/ai/providers/registry.ts.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS base_url TEXT;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_configs', 'ai_usage_log'] LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_provider_check');
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (provider IN (
         ''openai'', ''anthropic'', ''gemini'', ''groq'', ''openrouter'',
         ''xai'', ''mistral'', ''deepseek'', ''cerebras'', ''openai_compatible''))',
      t, t || '_provider_check');
  END LOOP;
END $$;

-- A custom endpoint needs its base URL.
ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_openai_compatible_base_url_check;
ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_openai_compatible_base_url_check
  CHECK (provider <> 'openai_compatible' OR (base_url IS NOT NULL AND btrim(base_url) <> ''));
