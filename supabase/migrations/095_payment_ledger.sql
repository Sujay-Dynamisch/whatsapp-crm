-- ============================================================
-- 095: Payment ledger per lead (Payments module).
--
--   * payment_plans        one per lead: full price + type
--                          ('full' = pays everything at once,
--                           'advance' = pays an advance, then the rest)
--   * payment_installments every payment received (amount, method,
--                          date, note) — editable / deletable
--
-- Balance = full price − sum(installments). The API marks the lead paid
-- (existing paid tag → journeys stop) once the balance reaches 0, and
-- un-marks it if an edit opens a balance again. Same access as
-- payment_records: members read, writes via the API, 'payments'
-- feature + area gates, scoped callers only see their own leads.
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_plans (
  contact_id  UUID PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  total_price NUMERIC(12, 2) NOT NULL CHECK (total_price >= 0),
  plan        TEXT NOT NULL DEFAULT 'full' CHECK (plan IN ('full', 'advance')),
  updated_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_plans_account ON payment_plans (account_id);

CREATE TABLE IF NOT EXISTS payment_installments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  amount      NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  method      TEXT,
  paid_on     DATE NOT NULL DEFAULT CURRENT_DATE,
  note        TEXT,
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_installments_contact ON payment_installments (contact_id, paid_on);
CREATE INDEX IF NOT EXISTS idx_payment_installments_account ON payment_installments (account_id);

ALTER TABLE payment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_installments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_plans_select ON payment_plans;
CREATE POLICY payment_plans_select ON payment_plans FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS payment_installments_select ON payment_installments;
CREATE POLICY payment_installments_select ON payment_installments FOR SELECT USING (is_account_member(account_id));

-- Feature gate (081) + caller scope (086).
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['payment_plans', 'payment_installments'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS feature_gate_select ON public.%I', tbl);
    EXECUTE format('CREATE POLICY feature_gate_select ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated
      USING (public.account_has_feature(account_id, %L))', tbl, 'payments');
    EXECUTE format('DROP POLICY IF EXISTS caller_scope_select ON public.%I', tbl);
    EXECUTE format('CREATE POLICY caller_scope_select ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated
      USING (NOT (SELECT public.my_caller_restricted()) OR EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = %I.contact_id))', tbl, tbl);
  END LOOP;
END $$;

-- Custom roles (079): the 'payments' area gates reads and writes.
DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN
    SELECT * FROM (VALUES
      ('payment_plans',        'payments', true),
      ('payment_installments', 'payments', true)
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
