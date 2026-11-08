-- ============================================================
-- 045_account_features
--
-- Per-account feature entitlements, set by the system admin.
--
--   1. SECURITY FIX — profiles.role. The admin portal treats
--      profiles.role IN ('admin','superadmin') as SYSTEM admin, but
--      034's trigger only froze account_role/account_id. Any signed-in
--      user could `update profiles set role = 'admin'` on their own row
--      through PostgREST and take over the admin portal. Now only the
--      service role / SQL editor can change it.
--   2. accounts.disabled_features — features switched OFF for the
--      account. Empty (= everything on) by default, so existing
--      customers keep every feature. Only the service role (admin
--      portal API) may change it.
--   3. account_has_feature() / my_disabled_features() — the checks used
--      by RLS, the app, and the background workers.
--   4. RESTRICTIVE write policies on each feature's tables. They AND
--      with the existing permissive policies, so a crafted client
--      can't write to a disabled feature by calling PostgREST directly.
--      Reads stay allowed (history remains visible). Service-role
--      writers (webhook, workers) bypass RLS and check the feature in
--      code instead.
--   5. claim_window_keepalives() also requires 'window_keepalive'.
--
-- Feature keys must match src/lib/features.ts.
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. profiles.role can't be self-assigned
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_profile_system_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' AND COALESCE(NEW.role, 'user') <> 'user' THEN
      RAISE EXCEPTION 'profiles.role cannot be set by users'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'profiles.role cannot be changed by users'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.enforce_profile_system_role() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_profile_system_role ON public.profiles;
CREATE TRIGGER enforce_profile_system_role
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_system_role();

-- ============================================================
-- 2. accounts.disabled_features
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS disabled_features TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN accounts.disabled_features IS
  'Feature keys switched off for this account by the system admin (see src/lib/features.ts). Empty = all features on. Writable only by the service role.';

CREATE OR REPLACE FUNCTION public.enforce_account_features_admin_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' AND cardinality(NEW.disabled_features) > 0 THEN
      RAISE EXCEPTION 'accounts.disabled_features is managed by the system admin'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.disabled_features IS DISTINCT FROM OLD.disabled_features THEN
      RAISE EXCEPTION 'accounts.disabled_features is managed by the system admin'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.enforce_account_features_admin_only() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_account_features_admin_only ON public.accounts;
CREATE TRIGGER enforce_account_features_admin_only
  BEFORE INSERT OR UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_features_admin_only();

-- ============================================================
-- 3. Checks
-- ============================================================
CREATE OR REPLACE FUNCTION public.account_has_feature(p_account_id UUID, p_feature TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM accounts
    WHERE id = p_account_id AND p_feature = ANY (disabled_features)
  );
$$;

REVOKE ALL ON FUNCTION public.account_has_feature(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.account_has_feature(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.account_has_feature(UUID, TEXT) TO authenticated, service_role;

-- The caller's own account's disabled list — one round-trip for the
-- request gate in the Next.js middleware.
CREATE OR REPLACE FUNCTION public.my_disabled_features()
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT a.disabled_features
     FROM profiles p
     JOIN accounts a ON a.id = p.account_id
     WHERE p.user_id = auth.uid()),
    '{}'::TEXT[]
  );
$$;

REVOKE ALL ON FUNCTION public.my_disabled_features() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.my_disabled_features() FROM anon;
GRANT EXECUTE ON FUNCTION public.my_disabled_features() TO authenticated;

-- ============================================================
-- 4. Restrictive write policies
-- ============================================================
DO $$
DECLARE
  gate RECORD;
BEGIN
  FOR gate IN
    SELECT * FROM (VALUES
      ('pipelines',                 'pipelines'),
      ('deals',                     'pipelines'),
      ('broadcasts',                'broadcasts'),
      ('automations',               'automations'),
      ('flows',                     'flows'),
      ('ai_configs',                'ai_agents'),
      ('window_keepalive_settings', 'window_keepalive'),
      ('api_keys',                  'api_access'),
      ('webhook_endpoints',         'api_access')
    ) AS t(tbl, feature)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS feature_gate_insert ON %I', gate.tbl);
    EXECUTE format(
      'CREATE POLICY feature_gate_insert ON %I AS RESTRICTIVE FOR INSERT TO authenticated
         WITH CHECK (public.account_has_feature(account_id, %L))',
      gate.tbl, gate.feature);
    EXECUTE format('DROP POLICY IF EXISTS feature_gate_update ON %I', gate.tbl);
    EXECUTE format(
      'CREATE POLICY feature_gate_update ON %I AS RESTRICTIVE FOR UPDATE TO authenticated
         USING (public.account_has_feature(account_id, %L))',
      gate.tbl, gate.feature);
  END LOOP;
END $$;

-- pipeline_stages has no account_id; gate through its pipeline.
DROP POLICY IF EXISTS feature_gate_insert ON pipeline_stages;
CREATE POLICY feature_gate_insert ON pipeline_stages AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM pipelines p
    WHERE p.id = pipeline_id AND public.account_has_feature(p.account_id, 'pipelines')
  ));
DROP POLICY IF EXISTS feature_gate_update ON pipeline_stages;
CREATE POLICY feature_gate_update ON pipeline_stages AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM pipelines p
    WHERE p.id = pipeline_id AND public.account_has_feature(p.account_id, 'pipelines')
  ));

-- ============================================================
-- 5. Keep-alive respects the entitlement
--    (044's function + one extra condition)
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_window_keepalives(p_limit INTEGER DEFAULT 100)
RETURNS TABLE(
  conversation_id UUID,
  account_id UUID,
  contact_id UUID,
  window_opened_at TIMESTAMPTZ,
  message_text TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT c.id, s.message_text AS text
    FROM conversations c
    JOIN window_keepalive_settings s ON s.account_id = c.account_id AND s.enabled
    WHERE c.last_customer_message_at IS NOT NULL
      AND c.last_customer_message_at <= NOW() - INTERVAL '24 hours' + make_interval(mins => s.lead_minutes)
      AND c.last_customer_message_at >  NOW() - INTERVAL '24 hours' + INTERVAL '5 minutes'
      AND c.window_keepalive_for IS DISTINCT FROM c.last_customer_message_at
      AND c.status <> 'closed'
      AND (c.last_message_at IS NULL
           OR c.last_message_at < NOW() - make_interval(mins => s.quiet_minutes))
      AND public.account_has_feature(c.account_id, 'window_keepalive')
      AND NOT EXISTS (
        SELECT 1
        FROM contact_tags ct
        JOIN tags t ON t.id = ct.tag_id
        WHERE ct.contact_id = c.contact_id
          AND lower(t.name) = 'unsubscribe'
      )
    ORDER BY c.last_customer_message_at
    LIMIT p_limit
    FOR UPDATE OF c SKIP LOCKED
  )
  UPDATE conversations c
  SET window_keepalive_for = c.last_customer_message_at
  FROM due
  WHERE c.id = due.id
  RETURNING c.id, c.account_id, c.contact_id, c.last_customer_message_at, due.text;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_window_keepalives(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_window_keepalives(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.claim_window_keepalives(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_window_keepalives(INTEGER) TO service_role;
