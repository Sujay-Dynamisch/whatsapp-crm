-- ============================================================
-- 105: Priority means "still waiting for a call".
--
-- A request marked "Spoke to them" (called) or Done is never Priority:
--   * moving to called / done clears Priority (whatever path did it);
--   * a NEW priority ask on a request someone already spoke to (the
--     customer taps "Request a callback" again or types it — 086/087/
--     101/102 upgrade the open request) re-opens it as "To call" (new),
--     so it shows as waiting instead of "Spoke to them" + Priority.
-- Fixes the rows already in that state. Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.callback_priority_means_waiting()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('called', 'done') THEN
    NEW.priority := 'normal';
  ELSIF NEW.priority = 'high' AND OLD.priority IS DISTINCT FROM 'high' AND NEW.status = 'called' THEN
    NEW.status := 'new';
    NEW.handled_at := NULL;
    NEW.handled_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS callback_priority_means_waiting ON callback_requests;
CREATE TRIGGER callback_priority_means_waiting
  BEFORE UPDATE ON callback_requests
  FOR EACH ROW EXECUTE FUNCTION public.callback_priority_means_waiting();

-- Existing rows: the customer asked again after the call → waiting again;
-- the rest were flagged after the call → just not Priority.
UPDATE callback_requests
SET status = 'new', handled_at = NULL, handled_by = NULL, updated_at = NOW()
WHERE status = 'called' AND priority = 'high' AND handled_at IS NOT NULL AND requested_at > handled_at;

UPDATE callback_requests
SET priority = 'normal', updated_at = NOW()
WHERE status IN ('called', 'done') AND priority = 'high';
