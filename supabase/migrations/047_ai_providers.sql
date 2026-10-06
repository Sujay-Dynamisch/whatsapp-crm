-- ============================================================
-- 047_ai_providers
--
-- More bring-your-own-key AI providers. Besides OpenAI and Anthropic,
-- accounts can now use OpenAI-compatible APIs — several with free
-- tiers: Google Gemini, Groq, OpenRouter, xAI (Grok), Mistral,
-- DeepSeek, Cerebras.
--
-- 029/033 pinned `provider` to ('openai','anthropic') with inline CHECKs
-- on ai_configs and ai_usage_log. Replace both. Keep this list in sync
-- with AI_PROVIDERS in src/lib/ai/providers/registry.ts.
--
-- Idempotent — safe to re-run.
-- ============================================================

DO $$
DECLARE
  t TEXT;
  c RECORD;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_configs', 'ai_usage_log'] LOOP
    -- Drop whatever CHECK currently constrains `provider` (auto-named
    -- by 029/033, or the one this migration added on a re-run).
    FOR c IN
      SELECT con.conname
      FROM pg_constraint con
      WHERE con.conrelid = format('public.%I', t)::regclass
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) ILIKE '%provider%'
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, c.conname);
    END LOOP;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (provider IN (
         ''openai'', ''anthropic'', ''gemini'', ''groq'', ''openrouter'',
         ''xai'', ''mistral'', ''deepseek'', ''cerebras''))',
      t, t || '_provider_check');
  END LOOP;
END $$;
