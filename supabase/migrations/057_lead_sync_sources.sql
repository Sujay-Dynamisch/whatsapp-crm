-- ============================================================
-- 057: lead_sync_sources — external registration feeds pulled into an
-- account's contacts by the journeyTick function
-- (src/lib/lead-sync/registrations.ts). One row per account; admins
-- flip `enabled` from Settings → API. Rows are created by an operator,
-- so accounts without a row never see the card or get synced.
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_sync_sources (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  tag TEXT NOT NULL DEFAULT 'website_registration',
  last_run_at TIMESTAMPTZ,
  last_report JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE lead_sync_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_sync_sources_select ON lead_sync_sources;
CREATE POLICY lead_sync_sources_select ON lead_sync_sources FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS lead_sync_sources_update ON lead_sync_sources;
CREATE POLICY lead_sync_sources_update ON lead_sync_sources FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

-- Swapnil Gautam's registration feed, off until switched on.
INSERT INTO lead_sync_sources (account_id, source_url)
SELECT 'ba23ef90-3416-44c9-84dd-b3b859d4d021', 'https://admin.swapnilgautam.com/api/auth'
WHERE EXISTS (SELECT 1 FROM accounts WHERE id = 'ba23ef90-3416-44c9-84dd-b3b859d4d021')
ON CONFLICT (account_id) DO NOTHING;
