-- ============================================================
-- 088: Callers can't read the account-wide dashboard (caller
-- management, 086). The overview RPC (076) is SECURITY DEFINER and
-- returns every lead's chats / reply queue; scoped callers get their
-- own dashboard in the app instead, and the RPC now refuses them too.
-- Everyone else is unchanged.
--
-- The 076 body is kept as dashboard_overview_all (not callable by
-- clients); dashboard_overview becomes a thin guard in front of it.
-- Idempotent — safe to re-run. (Re-running 076 alone would drop the
-- guard: re-run this file after it.)
-- ============================================================

DO $$
BEGIN
  IF to_regprocedure('public.dashboard_overview_all(integer, text)') IS NULL THEN
    ALTER FUNCTION public.dashboard_overview(INTEGER, TEXT) RENAME TO dashboard_overview_all;
  ELSE
    -- 076 was re-run after this file: keep its new body as the inner one.
    IF EXISTS (
      SELECT 1 FROM pg_proc
      WHERE oid = 'public.dashboard_overview(integer, text)'::regprocedure
        AND prosrc NOT LIKE '%my_caller_restricted%'
    ) THEN
      DROP FUNCTION public.dashboard_overview_all(INTEGER, TEXT);
      ALTER FUNCTION public.dashboard_overview(INTEGER, TEXT) RENAME TO dashboard_overview_all;
    END IF;
  END IF;
END $$;

ALTER FUNCTION public.dashboard_overview_all(INTEGER, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.dashboard_overview_all(INTEGER, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dashboard_overview(
  p_days INTEGER,
  p_tz TEXT DEFAULT 'UTC'
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.my_caller_restricted() THEN
    RAISE EXCEPTION 'The account overview is not available to callers' USING ERRCODE = '42501';
  END IF;
  RETURN public.dashboard_overview_all(p_days, p_tz);
END;
$$;
ALTER FUNCTION public.dashboard_overview(INTEGER, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.dashboard_overview(INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_overview(INTEGER, TEXT) TO authenticated;
