-- ============================================================
-- 050_journeys
--
-- Visual customer journeys (feature 'journeys'): long-running, multi-
-- step paths a contact moves through over hours or days — waits,
-- "wait for reply", branches on tags / button taps / replies, template
-- and text sends, tags, deals.
--
--   journeys              the graph (nodes + their outgoing slots) and
--                         the trigger, denormalised for dispatch
--   journey_enrollments   one contact's position in one journey
--   journey_events        every node entered / slot taken — the
--                         per-step conversion numbers on the canvas
--
-- Advancement is driven by events (new contact, first message, tag,
-- reply, button tap — from the webhook / automation dispatch) and by a
-- once-a-minute Cloud Scheduler tick that claims due waits with
-- claim_journey_enrollments().
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS journeys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  trigger_type    TEXT NOT NULL DEFAULT 'manual'
                  CHECK (trigger_type IN ('manual', 'contact_created', 'first_message', 'tag_added', 'button_clicked')),
  trigger_config  JSONB NOT NULL DEFAULT '{}'::jsonb,
  graph           JSONB NOT NULL DEFAULT '{"nodes": []}'::jsonb,
  allow_reentry   BOOLEAN NOT NULL DEFAULT false,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  activated_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journeys_dispatch
  ON journeys (account_id, trigger_type) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS journey_enrollments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id       UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'waiting', 'completed', 'exited', 'failed')),
  current_node_id  TEXT,
  -- 'timer' (wait) or 'reply' (wait for reply); next_run_at is the
  -- timer / reply timeout.
  wait_kind        TEXT CHECK (wait_kind IS NULL OR wait_kind IN ('timer', 'reply')),
  next_run_at      TIMESTAMPTZ,
  locked_at        TIMESTAMPTZ,
  steps_taken      INTEGER NOT NULL DEFAULT 0,
  context          JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error       TEXT,
  entered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one live enrollment per contact per journey.
CREATE UNIQUE INDEX IF NOT EXISTS idx_journey_enrollments_live
  ON journey_enrollments (journey_id, contact_id)
  WHERE status IN ('active', 'waiting');
CREATE INDEX IF NOT EXISTS idx_journey_enrollments_due
  ON journey_enrollments (next_run_at) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_journey_enrollments_contact
  ON journey_enrollments (account_id, contact_id) WHERE status = 'waiting';

CREATE TABLE IF NOT EXISTS journey_events (
  id             BIGSERIAL PRIMARY KEY,
  journey_id     UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  enrollment_id  UUID NOT NULL REFERENCES journey_enrollments(id) ON DELETE CASCADE,
  node_id        TEXT NOT NULL,
  -- 'entered' | 'exit:<slot>' | 'failed'
  event          TEXT NOT NULL,
  detail         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journey_events_journey ON journey_events (journey_id, node_id, event);

-- ------------------------------------------------------------
-- RLS: members read; agents+ edit journeys; only the service role
-- (engine) writes enrollments and events.
-- ------------------------------------------------------------
ALTER TABLE journeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE journey_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE journey_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS journeys_select ON journeys;
CREATE POLICY journeys_select ON journeys FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS journeys_insert ON journeys;
CREATE POLICY journeys_insert ON journeys FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS journeys_update ON journeys;
CREATE POLICY journeys_update ON journeys FOR UPDATE USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS journeys_delete ON journeys;
CREATE POLICY journeys_delete ON journeys FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS feature_gate_insert ON journeys;
CREATE POLICY feature_gate_insert ON journeys AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.account_has_feature(account_id, 'journeys'));
DROP POLICY IF EXISTS feature_gate_update ON journeys;
CREATE POLICY feature_gate_update ON journeys AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.account_has_feature(account_id, 'journeys'));

DROP POLICY IF EXISTS journey_enrollments_select ON journey_enrollments;
CREATE POLICY journey_enrollments_select ON journey_enrollments FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS journey_events_select ON journey_events;
CREATE POLICY journey_events_select ON journey_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM journeys j WHERE j.id = journey_id AND is_account_member(j.account_id)));

DROP TRIGGER IF EXISTS set_updated_at ON journeys;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON journeys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON journey_enrollments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON journey_enrollments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- Tick claim (service role): due timers and reply timeouts. A crashed
-- step (status 'active', lock older than 10 min) is reclaimed too.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_journey_enrollments(p_limit INTEGER DEFAULT 200)
RETURNS SETOF journey_enrollments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT e.id
    FROM journey_enrollments e
    JOIN journeys j ON j.id = e.journey_id
    WHERE j.status = 'active'
      AND public.account_has_feature(e.account_id, 'journeys')
      AND (
        (e.status = 'waiting' AND e.next_run_at <= NOW())
        OR (e.status = 'active' AND e.locked_at < NOW() - INTERVAL '10 minutes')
      )
    ORDER BY e.next_run_at NULLS FIRST
    LIMIT p_limit
    FOR UPDATE OF e SKIP LOCKED
  )
  UPDATE journey_enrollments e
  SET status = 'active', locked_at = NOW()
  FROM due
  WHERE e.id = due.id
  RETURNING e.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_journey_enrollments(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_journey_enrollments(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.claim_journey_enrollments(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_journey_enrollments(INTEGER) TO service_role;

-- Per-node / per-slot counts for the canvas overlay.
CREATE OR REPLACE FUNCTION public.journey_stats(p_journey_id UUID)
RETURNS TABLE(node_id TEXT, event TEXT, total BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT node_id, event, COUNT(*)::BIGINT
  FROM journey_events
  WHERE journey_id = p_journey_id
  GROUP BY node_id, event;
$$;

GRANT EXECUTE ON FUNCTION public.journey_stats(UUID) TO authenticated;
