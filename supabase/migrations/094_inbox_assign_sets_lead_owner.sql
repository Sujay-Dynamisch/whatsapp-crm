-- ============================================================
-- 094: Assigning a chat to a caller in the inbox also gives them the
-- lead (caller-managed accounts only).
--
-- Before, inbox assignment (conversations.assigned_agent_id) and lead
-- ownership (contacts.assigned_caller_id) were separate, so a caller
-- with a hand-assigned chat showed "0 leads" on the Callers page and got
-- no callbacks / reminders for it. Now, when a chat is assigned to an
-- ACTIVE caller of the workspace, the contact, its open engagement and
-- open callbacks move to that caller (audited INBOX_ASSIGNMENT). The
-- inbox already notifies the assignee, so no extra notification.
-- Assigning to a non-caller (owner/admin/agent) or unassigning the chat
-- leaves lead ownership as it is. Other accounts are unchanged.
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.inbox_assign_sets_lead_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact contacts%ROWTYPE;
  v_eng UUID;
BEGIN
  IF NEW.assigned_agent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_contact FROM contacts WHERE id = NEW.contact_id;
  IF v_contact.id IS NULL OR v_contact.assigned_caller_id IS NOT DISTINCT FROM NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;
  IF NOT public.account_has_feature(v_contact.account_id, 'caller_management') THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM callers
    WHERE account_id = v_contact.account_id AND user_id = NEW.assigned_agent_id AND status = 'active'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_eng FROM engagements
  WHERE contact_id = v_contact.id AND status = 'open' ORDER BY accepted_at DESC LIMIT 1;

  UPDATE contacts SET assigned_caller_id = NEW.assigned_agent_id WHERE id = v_contact.id;
  IF v_eng IS NOT NULL THEN
    UPDATE engagements SET assigned_caller_id = NEW.assigned_agent_id WHERE id = v_eng;
  END IF;
  UPDATE callback_requests SET assigned_caller_id = NEW.assigned_agent_id, updated_at = NOW()
  WHERE contact_id = v_contact.id AND status <> 'done';
  INSERT INTO caller_assignment_history (account_id, contact_id, engagement_id, from_caller_id, to_caller_id, actor_id, reason)
  VALUES (v_contact.account_id, v_contact.id, v_eng, v_contact.assigned_caller_id, NEW.assigned_agent_id, auth.uid(), 'INBOX_ASSIGNMENT');
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block a chat assignment.
  RAISE WARNING 'inbox_assign_sets_lead_owner failed for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.inbox_assign_sets_lead_owner() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_inbox_assign_set_lead_owner ON conversations;
CREATE TRIGGER on_inbox_assign_set_lead_owner
  AFTER INSERT OR UPDATE OF assigned_agent_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.inbox_assign_sets_lead_owner();

-- Chats already assigned to an active caller: give them those leads now.
UPDATE contacts c
SET assigned_caller_id = cv.assigned_agent_id
FROM conversations cv
JOIN callers cl ON cl.user_id = cv.assigned_agent_id AND cl.status = 'active'
WHERE cv.contact_id = c.id
  AND cl.account_id = c.account_id
  AND c.assigned_caller_id IS NULL
  AND public.account_has_feature(c.account_id, 'caller_management');

UPDATE callback_requests r
SET assigned_caller_id = c.assigned_caller_id, updated_at = NOW()
FROM contacts c
WHERE r.contact_id = c.id
  AND r.status <> 'done'
  AND r.assigned_caller_id IS NULL
  AND c.assigned_caller_id IS NOT NULL
  AND public.account_has_feature(c.account_id, 'caller_management');
