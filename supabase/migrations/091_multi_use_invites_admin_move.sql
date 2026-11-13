-- ============================================================
-- 091: Invite links many people can use, and a super-admin "move user
-- to workspace".
--
--   * account_invitations.multi_use — NEW links are reusable until they
--     expire or are revoked (existing ones keep their old behaviour);
--     use_count / last_used_at show how often a link was used.
--   * peek_invitation / redeem_invitation honour multi_use, and joining
--     applies the link's custom role (e.g. "Caller") directly.
--   * admin_move_user_to_account() — service role only (super-admin
--     API): move someone who signed up into their own workspace by
--     mistake into the right workspace with a role / custom role. Their
--     old workspace is deleted only when it's theirs, empty and has no
--     other members (same rule as joining).
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE account_invitations ADD COLUMN IF NOT EXISTS multi_use BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE account_invitations ALTER COLUMN multi_use SET DEFAULT TRUE;
ALTER TABLE account_invitations ADD COLUMN IF NOT EXISTS use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account_invitations ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.peek_invitation(
  p_token_hash TEXT
) RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv account_invitations%ROWTYPE;
  v_account_name TEXT;
BEGIN
  SELECT * INTO v_inv FROM account_invitations WHERE token_hash = p_token_hash;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_inv.accepted_at IS NOT NULL AND NOT v_inv.multi_use THEN
    RETURN json_build_object('ok', false, 'reason', 'used');
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;
  SELECT name INTO v_account_name FROM accounts WHERE id = v_inv.account_id;
  RETURN json_build_object(
    'ok', true,
    'account_name', v_account_name,
    'role', v_inv.role,
    'expires_at', v_inv.expires_at,
    'multi_use', v_inv.multi_use
  );
END;
$$;
ALTER FUNCTION public.peek_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.peek_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.peek_invitation(TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_other_members BOOLEAN;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL AND NOT v_inv.multi_use THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id
  FOR UPDATE OF p, a;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE account_id = v_old_account_id
      AND user_id <> v_caller_id
  ) INTO v_has_other_members;

  IF v_has_other_members THEN
    RAISE EXCEPTION 'Your account has other members; remove them or transfer ownership before joining another account'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_logs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_pending_executions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_runs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM deals WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM api_keys WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM webhook_endpoints WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM quick_replies WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM notifications WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_documents WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_chunks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_usage_log WHERE account_id = v_old_account_id
    -- Fork tables (journeys, callbacks, payments, …).
    UNION ALL SELECT 1 FROM carousel_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM button_clicks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM journeys WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM journey_enrollments WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM journey_messages WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM lead_sync_sources WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM lead_sync_issues WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM callback_requests WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM account_custom_roles WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM payment_tracking WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM payment_records WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role,
      custom_role_id = v_inv.custom_role_id
  WHERE user_id = v_caller_id;

  IF v_inv.multi_use THEN
    -- Shared link: stays open for the next person until it expires.
    UPDATE account_invitations
    SET use_count = use_count + 1,
        last_used_at = NOW(),
        accepted_by_user_id = v_caller_id
    WHERE id = v_inv.id;
  ELSE
    UPDATE account_invitations
    SET accepted_at = NOW(),
        accepted_by_user_id = v_caller_id
    WHERE id = v_inv.id;
  END IF;

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_move_user_to_account(
  p_user_id UUID,
  p_account_id UUID,
  p_role account_role_enum,
  p_custom_role_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_other_members BOOLEAN;
  v_has_data BOOLEAN;
BEGIN
  IF p_role = 'owner' THEN
    RAISE EXCEPTION 'Use ownership transfer to make someone an owner' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = p_account_id) THEN
    RAISE EXCEPTION 'Workspace not found' USING ERRCODE = '22023';
  END IF;
  IF p_custom_role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM account_custom_roles WHERE id = p_custom_role_id AND account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'That role does not belong to the chosen workspace' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = p_user_id
  FOR UPDATE OF p, a;
  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'User has no profile' USING ERRCODE = '22023';
  END IF;

  IF v_old_account_id = p_account_id THEN
    -- Same workspace: just the role.
    UPDATE profiles SET account_role = p_role, custom_role_id = p_custom_role_id WHERE user_id = p_user_id;
    RETURN p_account_id;
  END IF;

  IF v_old_account_owner = p_user_id THEN
    SELECT EXISTS (
      SELECT 1 FROM profiles WHERE account_id = v_old_account_id AND user_id <> p_user_id
    ) INTO v_has_other_members;
    IF v_has_other_members THEN
      RAISE EXCEPTION 'Their current workspace has other members; transfer its ownership first' USING ERRCODE = '23505';
    END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_logs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_pending_executions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_runs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM deals WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM api_keys WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM webhook_endpoints WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM quick_replies WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM notifications WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_documents WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_chunks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_usage_log WHERE account_id = v_old_account_id
    -- Fork tables (journeys, callbacks, payments, …).
    UNION ALL SELECT 1 FROM carousel_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM button_clicks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM journeys WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM journey_enrollments WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM journey_messages WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM lead_sync_sources WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM lead_sync_issues WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM callback_requests WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM account_custom_roles WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM payment_tracking WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM payment_records WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

    IF v_has_data THEN
      RAISE EXCEPTION 'Their current workspace already contains data; it would be lost' USING ERRCODE = '23505';
    END IF;
  END IF;

  DELETE FROM callers WHERE user_id = p_user_id AND account_id = v_old_account_id;
  UPDATE profiles
  SET account_id = p_account_id, account_role = p_role, custom_role_id = p_custom_role_id
  WHERE user_id = p_user_id;

  -- Their own empty workspace from sign-up is removed.
  IF v_old_account_owner = p_user_id THEN
    DELETE FROM accounts WHERE id = v_old_account_id;
  END IF;
  RETURN p_account_id;
END;
$$;
ALTER FUNCTION public.admin_move_user_to_account(UUID, UUID, account_role_enum, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_move_user_to_account(UUID, UUID, account_role_enum, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_move_user_to_account(UUID, UUID, account_role_enum, UUID) TO service_role;
