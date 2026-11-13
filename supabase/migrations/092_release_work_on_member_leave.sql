-- ============================================================
-- 092: A caller who leaves a workspace never keeps its leads.
--
-- "Remove member" (and the super-admin move, 091) moves the person's
-- profile to another account, but their leads / open engagements /
-- open callbacks in the OLD workspace stayed assigned to them — hidden
-- from the Callers page and from Admin Unassigned. Now, when a profile
-- leaves an account, that work goes to Admin Unassigned (audited as
-- MEMBER_REMOVED), their caller entry there is removed, and the
-- owners/admins get one notification. (Deleting the login already
-- clears the owner via ON DELETE SET NULL.)
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.release_work_on_member_leave()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF OLD.account_id IS NULL OR OLD.account_id IS NOT DISTINCT FROM NEW.account_id THEN
    RETURN NEW;
  END IF;

  INSERT INTO caller_assignment_history (account_id, contact_id, engagement_id, from_caller_id, to_caller_id, reason)
  SELECT c.account_id, c.id,
         (SELECT e.id FROM engagements e WHERE e.contact_id = c.id AND e.status = 'open' ORDER BY e.accepted_at DESC LIMIT 1),
         NEW.user_id, NULL, 'MEMBER_REMOVED'
  FROM contacts c
  WHERE c.account_id = OLD.account_id AND c.assigned_caller_id = NEW.user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE contacts SET assigned_caller_id = NULL
  WHERE account_id = OLD.account_id AND assigned_caller_id = NEW.user_id;
  UPDATE engagements SET assigned_caller_id = NULL
  WHERE account_id = OLD.account_id AND assigned_caller_id = NEW.user_id AND status = 'open';
  UPDATE callback_requests SET assigned_caller_id = NULL, updated_at = NOW()
  WHERE account_id = OLD.account_id AND assigned_caller_id = NEW.user_id AND status <> 'done';
  DELETE FROM callers WHERE account_id = OLD.account_id AND user_id = NEW.user_id;

  IF v_count > 0 THEN
    INSERT INTO notifications (account_id, user_id, type, title, body)
    SELECT OLD.account_id, p.user_id, 'callback_returned',
           'Caller removed — ' || v_count || ' lead' || CASE WHEN v_count = 1 THEN '' ELSE 's' END || ' moved to Admin Unassigned',
           COALESCE(NULLIF(NEW.full_name, ''), NEW.email) || ' left the workspace. Reassign their leads from the Callers page.'
    FROM profiles p
    WHERE p.account_id = OLD.account_id AND p.account_role IN ('owner', 'admin') AND p.user_id <> NEW.user_id;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block a membership change.
  RAISE WARNING 'release_work_on_member_leave failed for %: %', NEW.user_id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.release_work_on_member_leave() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_member_leave_release_work ON profiles;
CREATE TRIGGER on_member_leave_release_work
  AFTER UPDATE OF account_id ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.release_work_on_member_leave();
