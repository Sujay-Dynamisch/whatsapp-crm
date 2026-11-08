-- ============================================================
-- 054_journey_workflows
--
-- Turns journeys into an n8n-style workflow builder:
--
--   * New triggers: 'webhook' (external system POSTs JSON to a secret
--     URL), 'schedule' (interval / daily / weekly run for a tagged
--     audience) and 'inbound_message' (any customer message or a
--     keyword).
--   * Steps pass data to each other — each step's output is kept on
--     the enrollment context and logged on journey_events.data, which
--     drives the run history ("executions") in the editor.
--
--   journeys.webhook_token       secret path segment of the hook URL
--   journeys.next_scheduled_at   when a 'schedule' journey runs next
--   journey_events.data          step output / error detail (JSON)
--   claim_scheduled_journeys()   tick claim for due schedules
--
-- Idempotent — safe to re-run.
-- ============================================================

DO $$
DECLARE
  c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'journeys'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%trigger_type%'
  LOOP
    EXECUTE format('ALTER TABLE journeys DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE journeys
  ADD CONSTRAINT journeys_trigger_type_check CHECK (trigger_type IN (
    'manual', 'contact_created', 'first_message', 'tag_added', 'button_clicked',
    'inbound_message', 'webhook', 'schedule'
  ));

ALTER TABLE journeys
  ADD COLUMN IF NOT EXISTS webhook_token TEXT,
  ADD COLUMN IF NOT EXISTS next_scheduled_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_journeys_webhook_token
  ON journeys (webhook_token) WHERE webhook_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journeys_schedule_due
  ON journeys (next_scheduled_at) WHERE status = 'active' AND trigger_type = 'schedule';

ALTER TABLE journey_events
  ADD COLUMN IF NOT EXISTS data JSONB;

CREATE INDEX IF NOT EXISTS idx_journey_events_enrollment
  ON journey_events (enrollment_id, id);
CREATE INDEX IF NOT EXISTS idx_journey_enrollments_recent
  ON journey_enrollments (journey_id, entered_at DESC);

-- ------------------------------------------------------------
-- Tick claim for schedules (service role). Pushes next_scheduled_at
-- out by a 10-minute lease so overlapping ticks never run the same
-- schedule twice; the engine then sets the real next run time.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_scheduled_journeys(p_limit INTEGER DEFAULT 20)
RETURNS SETOF journeys
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT j.id
    FROM journeys j
    WHERE j.status = 'active'
      AND j.trigger_type = 'schedule'
      AND j.next_scheduled_at IS NOT NULL
      AND j.next_scheduled_at <= NOW()
      AND public.account_has_feature(j.account_id, 'journeys')
    ORDER BY j.next_scheduled_at
    LIMIT p_limit
    FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE journeys j
  SET next_scheduled_at = NOW() + INTERVAL '10 minutes'
  FROM due
  WHERE j.id = due.id
  RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_scheduled_journeys(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_scheduled_journeys(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.claim_scheduled_journeys(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_scheduled_journeys(INTEGER) TO service_role;

NOTIFY pgrst, 'reload schema';
