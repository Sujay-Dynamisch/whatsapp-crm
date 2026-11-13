-- ============================================================
-- 093: A caller sees the contact of every chat assigned to them.
--
-- 086 let a scoped caller read conversations assigned to them in the
-- inbox, but contacts only when they own the lead (assigned_caller_id).
-- A chat assigned by hand to a caller therefore showed "Unknown" (the
-- contact row was hidden). Contacts are now visible when the caller owns
-- the lead OR one of the contact's conversations is assigned to them.
--
-- The lookup is a SECURITY DEFINER function so the contacts policy does
-- not query conversations under RLS (conversations' policy already
-- reads contacts — doing it inline would recurse).
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.my_assigned_chat_contact_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT contact_id FROM conversations WHERE assigned_agent_id = auth.uid();
$$;
ALTER FUNCTION public.my_assigned_chat_contact_ids() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.my_assigned_chat_contact_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_assigned_chat_contact_ids() TO authenticated;

DROP POLICY IF EXISTS caller_scope_select ON contacts;
CREATE POLICY caller_scope_select ON contacts AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    NOT (SELECT public.my_caller_restricted())
    OR assigned_caller_id = auth.uid()
    OR id IN (SELECT public.my_assigned_chat_contact_ids())
  );
