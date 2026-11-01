-- ============================================================
-- 062: custom roles — per-area permissions on top of the built-in roles.
--
-- An account can define its own roles ("Sales agent", "Support",
-- "Marketing"…). Each one is built on a base role (admin / agent /
-- viewer — never owner) and sets None / View / Edit per area of the app
-- (src/lib/auth/permissions.ts). A custom role can only RESTRICT its base
-- role: every existing policy keeps checking the base role exactly as
-- before, and the gates below AND an extra condition on top.
--
--   1. account_custom_roles — the roles (permissions JSON: area → level).
--   2. profiles.custom_role_id / account_invitations.custom_role_id.
--      A member with a custom role always has account_role = its base
--      role (kept in sync by trigger). Members can't set it themselves;
--      set_member_access() (admin+) and invitations do.
--   3. my_area_level(area) → 0 none / 1 view / 2 edit for the caller
--      (2 when they have no custom role); my_permissions() for the app.
--   4. RESTRICTIVE policies: writes need Edit on the table's area; areas
--      whose tables only their own pages read also need View to read.
--   5. A role in use (members / pending invites) can't be deleted — that
--      would silently lift the restrictions.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- 1. Roles ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_custom_roles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  description  TEXT CHECK (description IS NULL OR char_length(description) <= 300),
  base_role    account_role_enum NOT NULL CHECK (base_role <> 'owner'),
  permissions  JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(permissions) = 'object'),
  created_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_custom_roles_name
  ON account_custom_roles (account_id, lower(btrim(name)));

-- 2. Who has which role ----------------------------------------------
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS custom_role_id UUID
  REFERENCES account_custom_roles(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_profiles_custom_role ON profiles (custom_role_id) WHERE custom_role_id IS NOT NULL;
ALTER TABLE account_invitations ADD COLUMN IF NOT EXISTS custom_role_id UUID
  REFERENCES account_custom_roles(id) ON DELETE SET NULL;

-- 3. Caller's access ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_area_level(p_area TEXT)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p.custom_role_id IS NULL OR r.id IS NULL THEN 2
    ELSE CASE r.permissions ->> p_area WHEN 'edit' THEN 2 WHEN 'view' THEN 1 ELSE 0 END
  END
  FROM profiles p
  LEFT JOIN account_custom_roles r ON r.id = p.custom_role_id AND r.account_id = p.account_id
  WHERE p.user_id = auth.uid()
$$;
ALTER FUNCTION public.my_area_level(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.my_area_level(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_area_level(TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.my_permissions()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
    'custom_role_id', r.id,
    'name', r.name,
    'base_role', r.base_role,
    'permissions', r.permissions
  ) END
  FROM profiles p
  LEFT JOIN account_custom_roles r ON r.id = p.custom_role_id AND r.account_id = p.account_id
  WHERE p.user_id = auth.uid()
$$;
ALTER FUNCTION public.my_permissions() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.my_permissions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_permissions() TO authenticated;

-- Roles: members read their account's roles; admins with Edit on
-- "Team & roles" manage them.
ALTER TABLE account_custom_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_custom_roles_select ON account_custom_roles;
CREATE POLICY account_custom_roles_select ON account_custom_roles FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS account_custom_roles_write ON account_custom_roles;
CREATE POLICY account_custom_roles_write ON account_custom_roles FOR ALL
  USING (is_account_member(account_id, 'admin') AND (SELECT public.my_area_level('members')) >= 2)
  WITH CHECK (is_account_member(account_id, 'admin') AND (SELECT public.my_area_level('members')) >= 2);

-- 2b. Keep profiles consistent ------------------------------------------
-- * members can't change custom_role_id themselves;
-- * taking a custom role sets account_role to its base role (never owner);
-- * a built-in role change clears the custom role;
-- * moving account (invitation) clears it (the invite re-applies its own).
CREATE OR REPLACE FUNCTION public.profiles_custom_role_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_base account_role_enum;
  v_role_account UUID;
BEGIN
  IF NEW.custom_role_id IS DISTINCT FROM OLD.custom_role_id AND current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'custom_role_id cannot be changed directly; use set_member_access()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.account_id IS DISTINCT FROM OLD.account_id AND NEW.custom_role_id IS NOT DISTINCT FROM OLD.custom_role_id THEN
    NEW.custom_role_id := NULL;
  END IF;

  IF NEW.custom_role_id IS NOT NULL THEN
    SELECT base_role, account_id INTO v_base, v_role_account FROM account_custom_roles WHERE id = NEW.custom_role_id;
    IF v_role_account IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'That role belongs to another account' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.custom_role_id IS DISTINCT FROM OLD.custom_role_id THEN
      IF OLD.account_role = 'owner' AND NEW.account_id = OLD.account_id THEN
        RAISE EXCEPTION 'The owner cannot have a custom role' USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.account_role := v_base;
    ELSIF NEW.account_role IS DISTINCT FROM OLD.account_role AND NEW.account_role <> v_base THEN
      -- Switched to a built-in role.
      NEW.custom_role_id := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.profiles_custom_role_sync() OWNER TO postgres;
DROP TRIGGER IF EXISTS profiles_custom_role_sync ON public.profiles;
-- Fires after enforce_profile_privilege_columns (name order).
CREATE TRIGGER profiles_custom_role_sync
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_custom_role_sync();

-- A role's base role changes → its members follow.
CREATE OR REPLACE FUNCTION public.custom_role_base_changed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE profiles SET account_role = NEW.base_role
  WHERE custom_role_id = NEW.id AND account_role IS DISTINCT FROM NEW.base_role AND account_role <> 'owner';
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.custom_role_base_changed() OWNER TO postgres;
DROP TRIGGER IF EXISTS custom_role_base_changed ON public.account_custom_roles;
CREATE TRIGGER custom_role_base_changed
  AFTER UPDATE OF base_role ON public.account_custom_roles
  FOR EACH ROW EXECUTE FUNCTION public.custom_role_base_changed();

-- An accepted invitation with a custom role applies it (redeem_invitation
-- moves the profile first, then stamps accepted_at).
CREATE OR REPLACE FUNCTION public.apply_invitation_custom_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE profiles SET custom_role_id = NEW.custom_role_id
  WHERE user_id = NEW.accepted_by_user_id AND account_id = NEW.account_id AND account_role <> 'owner';
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.apply_invitation_custom_role() OWNER TO postgres;
DROP TRIGGER IF EXISTS apply_invitation_custom_role ON public.account_invitations;
CREATE TRIGGER apply_invitation_custom_role
  AFTER UPDATE OF accepted_at ON public.account_invitations
  FOR EACH ROW
  WHEN (OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL AND NEW.custom_role_id IS NOT NULL)
  EXECUTE FUNCTION public.apply_invitation_custom_role();

-- Admin+ gives a member a built-in role or a custom role.
CREATE OR REPLACE FUNCTION public.set_member_access(
  p_user_id UUID,
  p_role account_role_enum,
  p_custom_role_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account UUID;
  v_caller_role account_role_enum;
  v_target_account UUID;
  v_target_role account_role_enum;
BEGIN
  SELECT account_id, account_role INTO v_caller_account, v_caller_role FROM profiles WHERE user_id = auth.uid();
  IF v_caller_account IS NULL OR v_caller_role NOT IN ('owner', 'admin') OR public.my_area_level('members') < 2 THEN
    RAISE EXCEPTION 'This action requires the admin role with access to Team & roles' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role' USING ERRCODE = '42501';
  END IF;
  SELECT account_id, account_role INTO v_target_account, v_target_role FROM profiles WHERE user_id = p_user_id;
  IF v_target_account IS DISTINCT FROM v_caller_account THEN
    RAISE EXCEPTION 'Member not found' USING ERRCODE = '22023';
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use ownership transfer to change the owner' USING ERRCODE = '42501';
  END IF;

  IF p_custom_role_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM account_custom_roles WHERE id = p_custom_role_id AND account_id = v_caller_account) THEN
      RAISE EXCEPTION 'Role not found' USING ERRCODE = '22023';
    END IF;
    UPDATE profiles SET custom_role_id = p_custom_role_id WHERE user_id = p_user_id;
  ELSE
    IF p_role IS NULL OR p_role = 'owner' THEN
      RAISE EXCEPTION 'Choose admin, agent or viewer' USING ERRCODE = '22023';
    END IF;
    UPDATE profiles SET account_role = p_role, custom_role_id = NULL WHERE user_id = p_user_id;
  END IF;
END;
$$;
ALTER FUNCTION public.set_member_access(UUID, account_role_enum, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_access(UUID, account_role_enum, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_access(UUID, account_role_enum, UUID) TO authenticated;

-- 4. Area gates --------------------------------------------------------
-- Writes: Edit on the area. Reads (exclusive areas only): View.
DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN
    SELECT * FROM (VALUES
      -- table,                      area,              gate reads
      ('conversations',              'inbox',           false),
      ('messages',                   'inbox',           false),
      ('message_reactions',          'inbox',           false),
      ('contacts',                   'contacts',        false),
      ('contact_notes',              'contacts',        false),
      ('contact_tags',               'contacts',        false),
      ('contact_custom_values',      'contacts',        false),
      ('tags',                       'contacts',        false),
      ('pipelines',                  'pipelines',       true),
      ('pipeline_stages',            'pipelines',       true),
      ('deals',                      'pipelines',       true),
      ('broadcasts',                 'broadcasts',      true),
      ('broadcast_recipients',       'broadcasts',      true),
      ('message_templates',          'templates',       false),
      ('automations',                'automations',     true),
      ('automation_steps',           'automations',     true),
      ('flows',                      'flows',           true),
      ('flow_nodes',                 'flows',           true),
      ('journeys',                   'journeys',        true),
      ('ai_configs',                 'ai_agents',       true),
      ('ai_knowledge_documents',     'ai_agents',       true),
      ('callback_requests',          'callbacks',       true),
      ('button_clicks',              'button_clicks',   true),
      ('lead_sync_issues',           'failed_messages', true),
      ('whatsapp_config',            'settings',        false),
      ('custom_fields',              'settings',        false),
      ('quick_replies',              'settings',        false),
      ('delivery_settings',          'settings',        false),
      ('language_settings',          'settings',        false),
      ('window_keepalive_settings',  'settings',        false),
      ('lead_sync_sources',          'settings',        false),
      ('api_keys',                   'api_access',      true),
      ('webhook_endpoints',          'api_access',      true),
      ('account_invitations',        'members',         false)
    ) AS t(tbl, area, gate_reads)
  LOOP
    CONTINUE WHEN to_regclass('public.' || g.tbl) IS NULL;
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
