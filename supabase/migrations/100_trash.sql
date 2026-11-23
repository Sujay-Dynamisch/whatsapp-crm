-- ============================================================
-- 100: Trash — admin-only delete with restore.
--
--   trash_items  a copy of every deleted callback request (with its
--                timeline) and payment entry. Deleting moves the record
--                here; an admin can restore it or delete it forever.
--
-- Security
--   * Only admins/owners can read the trash (RLS below). Writes happen
--     on the server (service role) after an admin check.
--   * Defence in depth: deleting callback requests or payment entries
--     directly is limited to admins/owners at the database level too.
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS trash_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('callback', 'payment')),
  record_id    UUID NOT NULL,
  contact_id   UUID,
  -- Short human description ("Callback — Priya, 919…", "₹5,000 payment — Priya").
  label        TEXT,
  -- The deleted row (+ related rows) exactly as it was, for restore.
  payload      JSONB NOT NULL,
  deleted_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  restored_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  restored_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trash_items_account ON trash_items (account_id, kind, deleted_at DESC) WHERE restored_at IS NULL;

ALTER TABLE trash_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trash_items_select ON trash_items;
CREATE POLICY trash_items_select ON trash_items FOR SELECT TO authenticated
  USING (is_account_member(account_id, 'admin'));

-- Admin-only deletes, enforced by the database as well.
DROP POLICY IF EXISTS admin_only_delete ON callback_requests;
CREATE POLICY admin_only_delete ON callback_requests AS RESTRICTIVE FOR DELETE TO authenticated
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS admin_only_delete ON payment_installments;
CREATE POLICY admin_only_delete ON payment_installments AS RESTRICTIVE FOR DELETE TO authenticated
  USING (is_account_member(account_id, 'admin'));
