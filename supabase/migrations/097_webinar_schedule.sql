-- ============================================================
-- 097: Webinar schedule (off-by-default 'webinar_schedule' feature,
-- on only for Swapnil Gautam's account).
--
--   * webinar_sessions   each live session: start time, optional Zoom
--                        link, scheduled / cancelled
--   * webinar_settings   timing rules (minutes before the session) per
--                        weekday / weekend, check-in hour, default times
--
-- The webinar journey reads upcoming sessions instead of its fixed
-- "every day at 8 PM / 3 PM" rule (falls back to that rule when no
-- session is scheduled). Cancelling or moving a session re-plans the
-- leads booked into it (API). Same access shape as other modules:
-- members read, writes via the API, feature + 'webinars' area gates.
-- Idempotent — safe to re-run.
-- ============================================================

-- 1. Feature: off for every account except Swapnil's ---------------------
UPDATE accounts
SET disabled_features = array_append(disabled_features, 'webinar_schedule')
WHERE id <> 'ba23ef90-3416-44c9-84dd-b3b859d4d021'
  AND NOT ('webinar_schedule' = ANY (disabled_features));

CREATE OR REPLACE FUNCTION public.accounts_default_off_features()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['failed_messages', 'payments', 'caller_management', 'webinar_schedule'] LOOP
    IF NOT (f = ANY (NEW.disabled_features)) THEN
      NEW.disabled_features := array_append(NEW.disabled_features, f);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.accounts_default_off_features() OWNER TO postgres;

-- 2. Tables -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webinar_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  starts_at   TIMESTAMPTZ NOT NULL,
  link        TEXT,
  status      TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  note        TEXT,
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webinar_sessions_slot
  ON webinar_sessions (account_id, starts_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_webinar_sessions_upcoming ON webinar_sessions (account_id, starts_at);

CREATE TABLE IF NOT EXISTS webinar_settings (
  account_id                UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- Minutes before the session (defaults = today's journey rules:
  -- weekday 8 PM → cut-off & Msg 2 at 2 PM; weekend 3 PM → cut-off
  -- 10 AM, Msg 2 11 AM; Msg 3 one hour before).
  weekday_cutoff_min        INTEGER NOT NULL DEFAULT 360 CHECK (weekday_cutoff_min BETWEEN 0 AND 2880),
  weekday_msg2_min          INTEGER NOT NULL DEFAULT 360 CHECK (weekday_msg2_min BETWEEN 0 AND 2880),
  weekday_msg3_min          INTEGER NOT NULL DEFAULT 60  CHECK (weekday_msg3_min BETWEEN 0 AND 1440),
  weekend_cutoff_min        INTEGER NOT NULL DEFAULT 300 CHECK (weekend_cutoff_min BETWEEN 0 AND 2880),
  weekend_msg2_min          INTEGER NOT NULL DEFAULT 240 CHECK (weekend_msg2_min BETWEEN 0 AND 2880),
  weekend_msg3_min          INTEGER NOT NULL DEFAULT 60  CHECK (weekend_msg3_min BETWEEN 0 AND 1440),
  checkin_hour              INTEGER NOT NULL DEFAULT 7   CHECK (checkin_hour BETWEEN 0 AND 23),
  default_weekday_time      TEXT NOT NULL DEFAULT '20:00' CHECK (default_weekday_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  default_weekend_time      TEXT NOT NULL DEFAULT '15:00' CHECK (default_weekend_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE webinar_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webinar_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webinar_sessions_select ON webinar_sessions;
CREATE POLICY webinar_sessions_select ON webinar_sessions FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS webinar_settings_select ON webinar_settings;
CREATE POLICY webinar_settings_select ON webinar_settings FOR SELECT USING (is_account_member(account_id));

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['webinar_sessions', 'webinar_settings'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS feature_gate_select ON public.%I', tbl);
    EXECUTE format('CREATE POLICY feature_gate_select ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated
      USING (public.account_has_feature(account_id, %L))', tbl, 'webinar_schedule');
  END LOOP;
END $$;

-- Custom roles (079): the 'webinars' area gates reads and writes.
DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN
    SELECT * FROM (VALUES
      ('webinar_sessions', 'webinars', true),
      ('webinar_settings', 'webinars', true)
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
