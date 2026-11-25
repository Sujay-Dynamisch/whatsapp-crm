-- ============================================================
-- 103: Dashboard "Unassigned" counts only chats that really need someone.
--
-- 076 counted every open chat with no Inbox agent. With caller
-- management (086) leads are owned on the contact (assigned_caller_id),
-- and lead sync / journeys open a chat for every lead before the
-- customer ever writes — so the tile showed almost every chat (e.g. 707).
--
-- Now: open, no Inbox agent, the lead has no caller, and the customer
-- has written at least once. Matches the Inbox "Unassigned" filter
-- (src/lib/inbox/inbox-filters.ts).
--
-- Only the guard wrapper from 088 changes; the 076 body
-- (dashboard_overview_all) is untouched. Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.dashboard_overview(
  p_days INTEGER,
  p_tz TEXT DEFAULT 'UTC'
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_account UUID;
  v_unassigned BIGINT;
BEGIN
  IF public.my_caller_restricted() THEN
    RAISE EXCEPTION 'The account overview is not available to callers' USING ERRCODE = '42501';
  END IF;

  v_result := public.dashboard_overview_all(p_days, p_tz);

  SELECT p.account_id INTO v_account FROM profiles p WHERE p.user_id = auth.uid();

  SELECT count(*) INTO v_unassigned
  FROM conversations c
  JOIN contacts ct ON ct.id = c.contact_id
  WHERE c.account_id = v_account
    AND c.status = 'open'
    AND c.assigned_agent_id IS NULL
    AND ct.assigned_caller_id IS NULL
    AND c.last_inbound_at IS NOT NULL;

  IF v_result ? 'attention' THEN
    v_result := jsonb_set(v_result, '{attention,unassigned}', to_jsonb(v_unassigned));
  END IF;
  RETURN v_result;
END;
$$;
ALTER FUNCTION public.dashboard_overview(INTEGER, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.dashboard_overview(INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_overview(INTEGER, TEXT) TO authenticated;
