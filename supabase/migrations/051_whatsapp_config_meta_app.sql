-- ============================================================
-- 051_whatsapp_config_meta_app
--
-- Per-account Meta App credentials, so a customer whose WABA lives
-- under their own Meta App can be onboarded from the settings form
-- without adding their secret to META_APP_SECRET and redeploying.
--
--   whatsapp_config.app_id       Meta App ID (numeric). Also used for
--                                template media-header uploads.
--   whatsapp_config.app_secret   Meta App Secret, encrypted with
--                                ENCRYPTION_KEY like access_token.
--                                The webhook accepts signatures from
--                                it in addition to META_APP_SECRET.
--
-- Both nullable — rows without them keep using the env values.
-- Idempotent — safe to re-run.
-- ============================================================

alter table public.whatsapp_config
  add column if not exists app_id text,
  add column if not exists app_secret text;
