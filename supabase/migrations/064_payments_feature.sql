-- ============================================================
-- 064: Payments becomes the off-by-default 'payments' feature, so the
-- system admin switches it per account under Admin → Features
-- (src/lib/features.ts). Swapnil Gautam's account keeps it on.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- 0. Column added to 063 after some databases had already run it.
ALTER TABLE payment_tracking ADD COLUMN IF NOT EXISTS closed_tag TEXT NOT NULL DEFAULT 'manually_closed';

-- 1. Off for every account except Swapnil's (left as is when re-run).
UPDATE accounts
SET disabled_features = array_append(disabled_features, 'payments')
WHERE id <> 'ba23ef90-3416-44c9-84dd-b3b859d4d021'
  AND NOT ('payments' = ANY (disabled_features));

-- 2. New accounts start with both off-by-default features off.
CREATE OR REPLACE FUNCTION public.accounts_default_off_features()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['failed_messages', 'payments'] LOOP
    IF NOT (f = ANY (NEW.disabled_features)) THEN
      NEW.disabled_features := array_append(NEW.disabled_features, f);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.accounts_default_off_features() OWNER TO postgres;

-- 3. Feature gate on the module's tables (reads and writes).
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['payment_tracking', 'payment_records'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS feature_gate_select ON public.%I', tbl);
    EXECUTE format('CREATE POLICY feature_gate_select ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated
      USING (public.account_has_feature(account_id, %L))', tbl, 'payments');
  END LOOP;
END $$;
