-- ============================================================
-- 065: live alerts — notifications the team must act on right away.
-- The app pops every new notification up on screen (and as a desktop
-- alert when the tab is in the background), so these just need rows:
--
--   payment_click  — a contact tapped a payment / "join" button
--   message_failed — a message to a contact failed (not broadcasts —
--                    those have their own report); max 1 per chat / 6 h
--   window_closing — a customer's message is unanswered and their 24 h
--                    WhatsApp window closes within ~2 h
--                    (claim_window_closing_alerts(), every 5 min)
--
-- Recipients: owner + admins + the chat's assignee (notify_team()).
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned', 'callback_requested', 'callback_overdue', 'callback_returned',
    'health_alert', 'health_summary', 'lead_returned',
    'payment_click', 'message_failed', 'window_closing'
  ));

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS window_alerted_for TIMESTAMPTZ;

-- ------------------------------------------------------------
-- Owner, admins and the conversation's assignee (once each).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_team(
  p_account_id UUID,
  p_conversation_id UUID,
  p_contact_id UUID,
  p_type TEXT,
  p_title TEXT,
  p_body TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO notifications (account_id, user_id, type, conversation_id, contact_id, title, body)
  SELECT p_account_id, u.user_id, p_type, p_conversation_id, p_contact_id, p_title, p_body
  FROM (
    SELECT p.user_id FROM profiles p
    WHERE p.account_id = p_account_id AND p.account_role IN ('owner', 'admin')
    UNION
    SELECT c.assigned_agent_id FROM conversations c
    WHERE c.id = p_conversation_id AND c.assigned_agent_id IS NOT NULL
  ) u;
END;
$$;
ALTER FUNCTION public.notify_team(UUID, UUID, UUID, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_team(UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- "Name · +91…" for alert bodies.
CREATE OR REPLACE FUNCTION public.contact_label(p_contact_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN NULLIF(c.name, '') IS NULL OR c.name = c.phone THEN c.phone
    ELSE c.name || ' · ' || c.phone
  END
  FROM contacts c WHERE c.id = p_contact_id;
$$;
ALTER FUNCTION public.contact_label(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.contact_label(UUID) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- Payment / join button tapped.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.alert_payment_click()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label TEXT := COALESCE(NULLIF(NEW.button_text, ''), NEW.button_payload, '');
BEGIN
  IF lower(v_label) !~ '(pay|join)' THEN
    RETURN NEW;
  END IF;
  PERFORM notify_team(
    NEW.account_id, NEW.conversation_id, NEW.contact_id, 'payment_click',
    'Payment button tapped',
    COALESCE(contact_label(NEW.contact_id), 'A contact') || ' tapped “' || v_label || '”'
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'alert_payment_click failed: %', SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.alert_payment_click() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_payment_button_click ON button_clicks;
CREATE TRIGGER on_payment_button_click
  AFTER INSERT ON button_clicks
  FOR EACH ROW EXECUTE FUNCTION public.alert_payment_click();

-- ------------------------------------------------------------
-- A message to a contact failed.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.alert_message_failed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv conversations%ROWTYPE;
BEGIN
  IF NEW.status <> 'failed' OR NEW.sender_type = 'customer' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'failed' THEN
    RETURN NEW;
  END IF;
  -- Broadcast failures are reported on the broadcast itself.
  IF NEW.message_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM broadcast_recipients WHERE whatsapp_message_id = NEW.message_id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_conv FROM conversations WHERE id = NEW.conversation_id;
  IF v_conv.id IS NULL THEN
    RETURN NEW;
  END IF;
  -- At most one alert per chat every 6 hours.
  IF EXISTS (
    SELECT 1 FROM notifications
    WHERE conversation_id = v_conv.id AND type = 'message_failed'
      AND created_at > NOW() - INTERVAL '6 hours'
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM notify_team(
    v_conv.account_id, v_conv.id, v_conv.contact_id, 'message_failed',
    'Message not delivered',
    COALESCE(contact_label(v_conv.contact_id), 'A contact')
      || COALESCE(' — ' || NULLIF(NEW.error_title, ''), '')
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'alert_message_failed failed: %', SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.alert_message_failed() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_message_failed_insert ON messages;
CREATE TRIGGER on_message_failed_insert
  AFTER INSERT ON messages
  FOR EACH ROW WHEN (NEW.status = 'failed')
  EXECUTE FUNCTION public.alert_message_failed();

DROP TRIGGER IF EXISTS on_message_failed_update ON messages;
CREATE TRIGGER on_message_failed_update
  AFTER UPDATE OF status ON messages
  FOR EACH ROW WHEN (NEW.status = 'failed' AND OLD.status IS DISTINCT FROM 'failed')
  EXECUTE FUNCTION public.alert_message_failed();

-- ------------------------------------------------------------
-- 24 h window closing with the customer's last message unanswered.
-- Called every 5 minutes by the windowKeepalive Cloud Function.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_window_closing_alerts()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  n INTEGER := 0;
BEGIN
  FOR r IN
    UPDATE conversations c
    SET window_alerted_for = c.last_customer_message_at
    WHERE c.last_customer_message_at BETWEEN NOW() - INTERVAL '23 hours' AND NOW() - INTERVAL '22 hours'
      AND c.window_alerted_for IS DISTINCT FROM c.last_customer_message_at
      AND NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.conversation_id = c.id
          AND m.sender_type <> 'customer'
          AND m.created_at > c.last_customer_message_at
      )
    RETURNING c.id, c.account_id, c.contact_id, c.last_customer_message_at
  LOOP
    PERFORM notify_team(
      r.account_id, r.id, r.contact_id, 'window_closing',
      'Reply soon — chat window closing',
      COALESCE(contact_label(r.contact_id), 'A contact')
        || ' is waiting for a reply — free-form messages end in about '
        || GREATEST(1, CEIL(EXTRACT(EPOCH FROM (r.last_customer_message_at + INTERVAL '24 hours' - NOW())) / 3600))::INT
        || ' h.'
    );
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
ALTER FUNCTION public.claim_window_closing_alerts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_window_closing_alerts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_window_closing_alerts() TO service_role;
