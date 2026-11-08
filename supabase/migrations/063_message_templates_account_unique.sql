-- ============================================================
-- 052_message_templates_account_unique
--
-- Migration 014 made (user_id, name, language) unique on
-- message_templates. Since 017 templates belong to an account, and
-- template sync looks rows up by (account_id, name, language) but
-- inserts them with the syncing user's user_id. When that user
-- already has a template with the same name + language in another
-- account (or a row whose account_id changed), the insert trips the
-- old index and the sync reports "Failed to sync: <name> (<lang>)"
-- for exactly those templates.
--
-- Replace it with (account_id, name, language) — the key sync uses.
-- Duplicates under the new key are not deleted here: the index is
-- skipped with a NOTICE listing them, and the next template sync
-- removes the extras (it keeps one row per name + language).
--
-- Idempotent — safe to re-run.
-- ============================================================

DROP INDEX IF EXISTS message_templates_user_name_language_key;

DO $$
DECLARE
  dupe_count INT;
  sample TEXT;
BEGIN
  SELECT count(*), string_agg(
      account_id::text || ' / ' || name || ' / ' || COALESCE(language, '(null)') ||
        ' (' || n || ' rows)',
      E'\n  '
    )
  INTO dupe_count, sample
  FROM (
    SELECT account_id, name, language, count(*) AS n
    FROM message_templates
    GROUP BY account_id, name, language
    HAVING count(*) > 1
  ) dupes;

  IF dupe_count > 0 THEN
    RAISE NOTICE
      E'Skipped UNIQUE(account_id, name, language) on message_templates — % duplicate combination(s):\n  %\nRun template sync (it removes the extras), then re-run this migration.',
      dupe_count, sample;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS message_templates_account_name_language_key
      ON message_templates (account_id, name, language);
  END IF;
END $$;
