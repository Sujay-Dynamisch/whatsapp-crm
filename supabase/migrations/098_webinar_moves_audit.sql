-- ============================================================
-- 098: Webinar Schedule — reliable moves + change history.
--
--   * webinar_moves    background jobs that move booked leads after a
--                      session is cancelled / re-timed, or re-book leads
--                      whose session is no longer in the schedule
--                      ("resync"). Run by the minute job (journeyTick),
--                      never inside a web request, with progress for
--                      the page (total / moved / errors).
--   * webinar_changes  who changed which session, how, and how many
--                      booked leads it affected.
--
-- Same access shape as 097 (feature 'webinar_schedule', area 'webinars').
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS webinar_moves (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id    UUID REFERENCES webinar_sessions(id) ON DELETE SET NULL,
  -- The booked session time leads are moved off ('…+05:30'); NULL = resync.
  from_iso      TEXT,
  reason        TEXT NOT NULL CHECK (reason IN ('cancelled', 'time_changed', 'resync')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  total         INTEGER NOT NULL DEFAULT 0,
  moved         INTEGER NOT NULL DEFAULT 0,
  errors        JSONB NOT NULL DEFAULT '[]'::jsonb,
  requested_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_webinar_moves_pending ON webinar_moves (created_at) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_webinar_moves_account ON webinar_moves (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webinar_changes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id  UUID REFERENCES webinar_sessions(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  detail      TEXT,
  affected    INTEGER NOT NULL DEFAULT 0,
  actor_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webinar_changes_account ON webinar_changes (account_id, created_at DESC);

ALTER TABLE webinar_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE webinar_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webinar_moves_select ON webinar_moves;
CREATE POLICY webinar_moves_select ON webinar_moves FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS webinar_changes_select ON webinar_changes;
CREATE POLICY webinar_changes_select ON webinar_changes FOR SELECT USING (is_account_member(account_id));

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['webinar_moves', 'webinar_changes'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS feature_gate_select ON public.%I', tbl);
    EXECUTE format('CREATE POLICY feature_gate_select ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated
      USING (public.account_has_feature(account_id, %L))', tbl, 'webinar_schedule');
  END LOOP;
END $$;

DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN
    SELECT * FROM (VALUES
      ('webinar_moves',   'webinars', true),
      ('webinar_changes', 'webinars', true)
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
