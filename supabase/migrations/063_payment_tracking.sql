-- ============================================================
-- 063: Payments module — mark leads as paid / not paid by hand.
--
-- payment_tracking: one row per account that uses the module (created
-- by an operator; accounts without a row never see it). It names the
-- tags the module reads: `pending_tag` (payment link sent) and
-- `paid_tag` (paid — a journey exit tag, so marking paid ends the run)
-- and `closed_tag` (not proceeding).
--
-- payment_records: who paid, when, how much, marked by whom. One per
-- contact; "mark as not paid" deletes it and removes the paid tag.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_tracking (
  account_id  UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  pending_tag TEXT NOT NULL DEFAULT 'payment_link_sent',
  paid_tag    TEXT NOT NULL DEFAULT 'paid',
  -- Lead said "Not proceeding" / was closed — shown, not counted as pending.
  closed_tag  TEXT NOT NULL DEFAULT 'manually_closed',
  currency    TEXT NOT NULL DEFAULT 'INR',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payment_tracking ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_tracking_select ON payment_tracking;
CREATE POLICY payment_tracking_select ON payment_tracking FOR SELECT
  USING (is_account_member(account_id));

CREATE TABLE IF NOT EXISTS payment_records (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  amount      NUMERIC(12, 2),
  method      TEXT,
  note        TEXT,
  paid_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  marked_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_records_account_paid
  ON payment_records (account_id, paid_at DESC);

-- Read: members. Writes go through the API (service role), which checks
-- the agent role and the account's payment_tracking row.
ALTER TABLE payment_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_records_select ON payment_records;
CREATE POLICY payment_records_select ON payment_records FOR SELECT
  USING (is_account_member(account_id));

-- Swapnil Gautam's account only.
INSERT INTO payment_tracking (account_id)
SELECT 'ba23ef90-3416-44c9-84dd-b3b859d4d021'
WHERE EXISTS (SELECT 1 FROM accounts WHERE id = 'ba23ef90-3416-44c9-84dd-b3b859d4d021')
ON CONFLICT (account_id) DO NOTHING;

-- Custom roles (062): the 'payments' area gates reads and writes —
-- same shape as 062's table list, so the permissions contract test sees it.
DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN
    SELECT * FROM (VALUES
      -- table,               area,       gate reads
      ('payment_tracking',    'payments', true),
      ('payment_records',     'payments', true)
    ) AS t(tbl, area, gate_reads)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS perm_gate_insert ON public.%I', g.tbl);
    EXECUTE format('CREATE POLICY perm_gate_insert ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated
      WITH CHECK ((SELECT public.my_area_level(%L)) >= 2)', g.tbl, g.area);
    EXECUTE format('DROP POLICY IF EXISTS perm_gate_update ON public.%I', g.tbl);
    EXECUTE format('CREATE POLICY perm_gate_update ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated
      USING ((SELECT public.my_area_level(%L)) >= 2)', g.tbl, g.area);
    EXECUTE format('DROP POLICY IF EXISTS perm_gate_delete ON public.%I', g.tbl);
    EXECUTE format('CREATE POLICY perm_gate_delete ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated
      USING ((SELECT public.my_area_level(%L)) >= 2)', g.tbl, g.area);
    EXECUTE format('DROP POLICY IF EXISTS perm_gate_select ON public.%I', g.tbl);
    IF g.gate_reads THEN
      EXECUTE format('CREATE POLICY perm_gate_select ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated
        USING ((SELECT public.my_area_level(%L)) >= 1)', g.tbl, g.area);
    END IF;
  END LOOP;
END $$;
