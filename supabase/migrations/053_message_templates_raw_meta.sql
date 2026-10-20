-- ============================================================
-- 053_message_templates_raw_meta
--
-- Template sync (and the carousel send path) read and write
-- message_templates.raw_components / raw_meta_data, but no migration
-- ever created them. Every synced row failed with:
--   Could not find the 'raw_components' column of 'message_templates'
--   in the schema cache
--
--   raw_components   Meta's `components` array, verbatim — lets the
--                    send builder handle component types we don't
--                    model as columns (e.g. carousel cards).
--   raw_meta_data    Other Meta fields kept for reference.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS raw_components JSONB,
  ADD COLUMN IF NOT EXISTS raw_meta_data JSONB;

-- PostgREST caches the schema; reload so the API sees the new columns
-- immediately instead of after its next refresh.
NOTIFY pgrst, 'reload schema';
