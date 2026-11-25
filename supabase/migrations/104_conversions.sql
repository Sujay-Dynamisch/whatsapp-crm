-- ============================================================
-- 104: Conversions — a lead who pays becomes a customer.
--
-- Any real payment signal converts the lead:
--   * a payment record (Payments → Mark paid),
--   * a payment installment (ledger, advance or full),
--   * the account's paid tag (payment_tracking.paid_tag, e.g. from the
--     payment-gateway webhook or a journey).
-- Converting stores one row per contact in `conversions` (the lead's
-- caller at that moment, amount received so far) and adds a "customer"
-- tag so the lead shows as a customer everywhere.
--
-- Reads: members of the account; callers only their own leads.
-- Writes: only the server (admin-only API) — no client write policies.
-- Existing paid leads are back-filled at the end. Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id    UUID NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  caller_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  amount        NUMERIC(12, 2),
  source        TEXT NOT NULL DEFAULT 'manual'
                CHECK (source IN ('paid_tag', 'payment_record', 'installment', 'manual', 'backfill')),
  note          TEXT,
  converted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at     TIMESTAMPTZ,            -- an admin changed it: payments no longer overwrite the amount
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversions_account_at ON conversions (account_id, converted_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversions_caller ON conversions (caller_id);

ALTER TABLE conversions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversions_select ON conversions;
CREATE POLICY conversions_select ON conversions FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS feature_gate_select ON conversions;
CREATE POLICY feature_gate_select ON conversions AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.account_has_feature(account_id, 'payments'));
-- Callers (086) see only their own leads' conversions.
DROP POLICY IF EXISTS caller_scope_select ON conversions;
CREATE POLICY caller_scope_select ON conversions AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    NOT (SELECT public.my_caller_restricted())
    OR caller_id = auth.uid()
    OR EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = conversions.contact_id)
  );

-- ------------------------------------------------------------
-- record_conversion: create (or refresh the amount of) a conversion.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_conversion(p_contact UUID, p_source TEXT, p_at TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_caller UUID;
  v_amount NUMERIC(12, 2);
  v_owner UUID;
  v_tag UUID;
BEGIN
  SELECT account_id, assigned_caller_id INTO v_account, v_caller FROM contacts WHERE id = p_contact;
  IF v_account IS NULL THEN
    RETURN;
  END IF;

  -- Amount received so far: the ledger total, else the Mark-paid amount.
  SELECT COALESCE(
    NULLIF((SELECT sum(amount) FROM payment_installments WHERE contact_id = p_contact), 0),
    (SELECT amount FROM payment_records WHERE contact_id = p_contact)
  ) INTO v_amount;

  INSERT INTO conversions (account_id, contact_id, caller_id, amount, source, converted_at)
  VALUES (v_account, p_contact, v_caller, v_amount, p_source, COALESCE(p_at, NOW()))
  ON CONFLICT (contact_id) DO UPDATE
    SET amount = COALESCE(EXCLUDED.amount, conversions.amount), updated_at = NOW()
    WHERE conversions.edited_at IS NULL;

  -- "customer" tag (created on first use, owned by the account owner).
  SELECT id INTO v_tag FROM tags WHERE account_id = v_account AND lower(name) = 'customer' LIMIT 1;
  IF v_tag IS NULL THEN
    SELECT owner_user_id INTO v_owner FROM accounts WHERE id = v_account;
    INSERT INTO tags (account_id, user_id, name, color)
    VALUES (v_account, v_owner, 'customer', '#16a34a')
    RETURNING id INTO v_tag;
  END IF;
  INSERT INTO contact_tags (contact_id, tag_id) VALUES (p_contact, v_tag)
  ON CONFLICT (contact_id, tag_id) DO NOTHING;
END;
$$;
ALTER FUNCTION public.record_conversion(UUID, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_conversion(UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- Triggers: every payment path converts.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convert_on_payment_record()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.record_conversion(NEW.contact_id, 'payment_record', NEW.paid_at);
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.convert_on_payment_record() OWNER TO postgres;
DROP TRIGGER IF EXISTS convert_on_payment_record ON payment_records;
CREATE TRIGGER convert_on_payment_record
  AFTER INSERT OR UPDATE OF amount ON payment_records
  FOR EACH ROW EXECUTE FUNCTION public.convert_on_payment_record();

CREATE OR REPLACE FUNCTION public.convert_on_installment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.record_conversion(NEW.contact_id, 'installment', NEW.paid_on::timestamptz);
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.convert_on_installment() OWNER TO postgres;
DROP TRIGGER IF EXISTS convert_on_installment ON payment_installments;
CREATE TRIGGER convert_on_installment
  AFTER INSERT OR UPDATE OF amount ON payment_installments
  FOR EACH ROW EXECUTE FUNCTION public.convert_on_installment();

CREATE OR REPLACE FUNCTION public.convert_on_paid_tag()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tags t
    JOIN payment_tracking pt ON pt.account_id = t.account_id AND lower(t.name) = lower(pt.paid_tag)
    WHERE t.id = NEW.tag_id
  ) THEN
    PERFORM public.record_conversion(NEW.contact_id, 'paid_tag', NOW());
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.convert_on_paid_tag() OWNER TO postgres;
DROP TRIGGER IF EXISTS convert_on_paid_tag ON contact_tags;
CREATE TRIGGER convert_on_paid_tag
  AFTER INSERT ON contact_tags
  FOR EACH ROW EXECUTE FUNCTION public.convert_on_paid_tag();

-- ------------------------------------------------------------
-- Back-fill: every lead who already paid (earliest payment signal).
-- ------------------------------------------------------------
SELECT public.record_conversion(x.contact_id, 'backfill', x.at)
FROM (
  SELECT s.contact_id, min(s.at) AS at
  FROM (
    SELECT pr.contact_id, pr.paid_at AS at FROM payment_records pr
    UNION ALL
    SELECT pi.contact_id, pi.paid_on::timestamptz FROM payment_installments pi
    UNION ALL
    SELECT ct.contact_id, ct.created_at
    FROM contact_tags ct
    JOIN tags t ON t.id = ct.tag_id
    JOIN payment_tracking pt ON pt.account_id = t.account_id AND lower(t.name) = lower(pt.paid_tag)
  ) s
  GROUP BY s.contact_id
) x
WHERE NOT EXISTS (SELECT 1 FROM conversions c WHERE c.contact_id = x.contact_id);
