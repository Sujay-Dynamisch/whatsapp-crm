-- ============================================================
-- 106: Journey card numbers counted in the database.
--
-- The Journeys page counted people per journey by downloading every run
-- (thousands of rows, on every page load). This returns the same numbers
-- in one query: per PERSON (a callback follow-up / re-entry starts a new
-- run for the same contact), a paying lead's run is 'completed' (engine
-- PAID_TAG_NAMES), so:
--   completed   = has a completed run
--   in_progress = otherwise, has an active / waiting run
--   failed      = otherwise, has a failed run
-- SECURITY INVOKER: the caller's RLS applies (same rows the page could
-- read before). Idempotent.
-- ============================================================

CREATE INDEX IF NOT EXISTS journey_enrollments_journey_contact_idx
  ON journey_enrollments (journey_id, contact_id);

CREATE OR REPLACE FUNCTION public.journey_people_stats(p_journey_ids UUID[])
RETURNS TABLE (journey_id UUID, total BIGINT, in_progress BIGINT, completed BIGINT, failed BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH per AS (
    SELECT e.journey_id,
           e.contact_id,
           bool_or(e.status = 'completed') AS done,
           bool_or(e.status IN ('active', 'waiting')) AS live,
           bool_or(e.status = 'failed') AS bad
    FROM journey_enrollments e
    WHERE e.journey_id = ANY (p_journey_ids)
    GROUP BY e.journey_id, e.contact_id
  )
  SELECT per.journey_id,
         count(*),
         count(*) FILTER (WHERE NOT done AND live),
         count(*) FILTER (WHERE done),
         count(*) FILTER (WHERE NOT done AND NOT live AND bad)
  FROM per
  GROUP BY per.journey_id;
$$;

REVOKE ALL ON FUNCTION public.journey_people_stats(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.journey_people_stats(UUID[]) TO authenticated, service_role;
