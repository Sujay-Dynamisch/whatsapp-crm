-- ============================================================
-- 101: A callback request from a lead with no caller goes to the next
--      caller in the round-robin (instead of staying unassigned).
--
-- Applies to both ways a lead asks for a call:
--   * tapping a "Request a callback" button (tag trigger,
--     open_callback_request — 086), and
--   * typing it in a message, found by the AI (open_callback_from_intent
--     — 087; definite requests only, not "needs review").
-- The lead's owner is a caller while that caller is active; otherwise
-- the next active, lead-eligible caller in the round-robin order becomes
-- the lead's owner (contact + open engagement), logged in
-- caller_assignment_history. No eligible caller → unassigned as before.
-- Only for accounts with 'caller_management'. Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.assign_lead_round_robin(p_account_id UUID, p_contact_id UUID, p_reason TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID;
  v_from   UUID;
  v_eng    UUID;
BEGIN
  v_caller := public.next_round_robin_caller(p_account_id);
  IF v_caller IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT assigned_caller_id INTO v_from FROM contacts WHERE id = p_contact_id AND account_id = p_account_id;
  UPDATE contacts SET assigned_caller_id = v_caller WHERE id = p_contact_id AND account_id = p_account_id;
  SELECT id INTO v_eng FROM engagements
  WHERE contact_id = p_contact_id AND account_id = p_account_id AND status = 'open'
  ORDER BY accepted_at DESC LIMIT 1;
  IF v_eng IS NOT NULL THEN
    UPDATE engagements SET assigned_caller_id = v_caller WHERE id = v_eng;
  END IF;
  INSERT INTO caller_assignment_history (account_id, contact_id, engagement_id, from_caller_id, to_caller_id, reason)
  VALUES (p_account_id, p_contact_id, v_eng, v_from, v_caller, p_reason);
  RETURN v_caller;
END;
$$;
ALTER FUNCTION public.assign_lead_round_robin(UUID, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assign_lead_round_robin(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_lead_round_robin(UUID, UUID, TEXT) TO service_role;

-- Button tap (086) — unchanged except the round-robin fallback.
CREATE OR REPLACE FUNCTION open_callback_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact   contacts%ROWTYPE;
  v_conv_id   UUID;
  v_source    TEXT;
  v_kind      TEXT := 'tag';
  v_label     TEXT;
  v_managed   BOOLEAN;
  v_open      callback_requests%ROWTYPE;
  v_caller    UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tags WHERE id = NEW.tag_id AND lower(name) = 'callback_requested'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_contact FROM contacts WHERE id = NEW.contact_id;
  IF v_contact.id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT public.account_has_feature(v_contact.account_id, 'callbacks') THEN
    RETURN NEW;
  END IF;
  v_managed := public.account_has_feature(v_contact.account_id, 'caller_management');

  SELECT * INTO v_open FROM callback_requests
  WHERE contact_id = v_contact.id AND status <> 'done' LIMIT 1;
  -- Already waiting for a call (or already a priority request).
  IF v_open.id IS NOT NULL AND (NOT v_managed OR v_open.priority = 'high') THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_conv_id FROM conversations
  WHERE contact_id = v_contact.id
  ORDER BY last_message_at DESC NULLS LAST LIMIT 1;

  SELECT COALESCE(button_text, button_payload) INTO v_source FROM button_clicks
  WHERE contact_id = v_contact.id AND clicked_at > NOW() - INTERVAL '15 minutes'
  ORDER BY clicked_at DESC LIMIT 1;
  IF v_source IS NOT NULL THEN
    v_kind := 'whatsapp_button';
  ELSIF v_conv_id IS NOT NULL THEN
    SELECT left(content_text, 200) INTO v_source FROM messages
    WHERE conversation_id = v_conv_id AND sender_type = 'customer'
      AND created_at > NOW() - INTERVAL '15 minutes'
    ORDER BY created_at DESC LIMIT 1;
  END IF;

  IF v_managed THEN
    -- Owner = the customer's caller while that caller is active …
    SELECT c.user_id INTO v_caller FROM callers c
    WHERE c.account_id = v_contact.account_id AND c.user_id = v_contact.assigned_caller_id AND c.status = 'active';
    -- … otherwise the next caller in the round-robin (101).
    IF v_caller IS NULL THEN
      v_caller := public.assign_lead_round_robin(v_contact.account_id, v_contact.id, 'callback_round_robin');
    END IF;

    IF v_open.id IS NOT NULL THEN
      -- Upgrade the default follow-up to a priority request.
      UPDATE callback_requests
      SET priority = 'high', source = COALESCE(v_source, source), source_kind = v_kind,
          assigned_caller_id = v_caller, requested_at = NOW(), updated_at = NOW(), reminded_at = NULL
      WHERE id = v_open.id;
    ELSE
      INSERT INTO callback_requests
        (account_id, contact_id, conversation_id, source, source_kind, priority, assigned_caller_id)
      VALUES (v_contact.account_id, v_contact.id, v_conv_id, v_source, v_kind, 'high', v_caller)
      ON CONFLICT DO NOTHING;
    END IF;
  ELSE
    INSERT INTO callback_requests (account_id, contact_id, conversation_id, source)
    VALUES (v_contact.account_id, v_contact.id, v_conv_id, v_source)
    ON CONFLICT DO NOTHING;
  END IF;

  v_label := COALESCE(NULLIF(v_contact.name, ''), v_contact.phone)
    || CASE WHEN COALESCE(NULLIF(v_contact.name, ''), v_contact.phone) <> v_contact.phone
            THEN ' · ' || v_contact.phone ELSE '' END;

  IF v_caller IS NOT NULL THEN
    INSERT INTO notifications (account_id, user_id, type, conversation_id, contact_id, title, body)
    VALUES (v_contact.account_id, v_caller, 'callback_requested', v_conv_id, v_contact.id, 'Priority callback request', v_label);
  ELSE
    INSERT INTO notifications (account_id, user_id, type, conversation_id, contact_id, title, body)
    SELECT v_contact.account_id, p.user_id, 'callback_requested', v_conv_id, v_contact.id,
           CASE WHEN v_managed THEN 'Priority callback request (unassigned)' ELSE 'Callback request' END, v_label
    FROM profiles p
    WHERE p.account_id = v_contact.account_id AND p.account_role IN ('owner', 'admin');
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'open_callback_request failed for contact %: %', NEW.contact_id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION open_callback_request() OWNER TO postgres;

-- Typed request found by the AI (087) — unchanged except the fallback.
CREATE OR REPLACE FUNCTION public.open_callback_from_intent(
  p_account_id UUID,
  p_contact_id UUID,
  p_conversation_id UUID,
  p_message_id TEXT,
  p_text TEXT,
  p_definite BOOLEAN,
  p_meta JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_open    callback_requests%ROWTYPE;
  v_caller  UUID;
  v_assign  UUID;
  v_ev      JSONB;
BEGIN
  IF NOT public.account_has_feature(p_account_id, 'caller_management')
     OR NOT public.account_has_feature(p_account_id, 'callbacks') THEN
    RETURN 'off';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('callback:' || p_contact_id::text, 0));

  -- Provider retries / AI re-runs of the same message.
  IF EXISTS (SELECT 1 FROM callback_requests WHERE account_id = p_account_id AND source_message_id = p_message_id)
     OR EXISTS (SELECT 1 FROM callback_requests WHERE contact_id = p_contact_id
                AND evidence @> jsonb_build_array(jsonb_build_object('message_id', p_message_id))) THEN
    RETURN 'duplicate';
  END IF;

  SELECT assigned_caller_id INTO v_assign FROM contacts WHERE id = p_contact_id AND account_id = p_account_id;
  SELECT user_id INTO v_caller FROM callers
  WHERE account_id = p_account_id AND user_id = v_assign AND status = 'active';

  v_ev := jsonb_build_array(jsonb_build_object(
    'message_id', p_message_id, 'text', left(p_text, 500), 'at', NOW(),
    'confidence', p_meta -> 'confidence', 'definite', p_definite));

  SELECT * INTO v_open FROM callback_requests WHERE contact_id = p_contact_id AND status <> 'done' LIMIT 1;

  IF NOT p_definite THEN
    IF v_open.id IS NOT NULL THEN
      UPDATE callback_requests SET evidence = evidence || v_ev, updated_at = NOW() WHERE id = v_open.id;
      RETURN 'attached';
    END IF;
    -- Ambiguous: a normal task for a human to review; no priority, no alert.
    INSERT INTO callback_requests
      (account_id, contact_id, conversation_id, source, source_kind, priority, assigned_caller_id, source_message_id, ai_meta)
    VALUES (p_account_id, p_contact_id, p_conversation_id, left(p_text, 200), 'ai_review', 'normal', v_caller, p_message_id, p_meta)
    ON CONFLICT DO NOTHING;
    RETURN 'review';
  END IF;

  IF v_open.id IS NOT NULL AND v_open.priority = 'high' THEN
    UPDATE callback_requests SET evidence = evidence || v_ev, updated_at = NOW() WHERE id = v_open.id;
    RETURN 'attached';
  END IF;

  -- No active caller for this lead → next caller in the round-robin (101).
  IF v_caller IS NULL THEN
    v_caller := public.assign_lead_round_robin(p_account_id, p_contact_id, 'callback_round_robin');
  END IF;

  IF v_open.id IS NOT NULL THEN
    UPDATE callback_requests
    SET priority = 'high', source = left(p_text, 200), source_kind = 'ai_inbox_text', source_message_id = p_message_id,
        ai_meta = p_meta, assigned_caller_id = v_caller, requested_at = NOW(), updated_at = NOW(),
        conversation_id = COALESCE(conversation_id, p_conversation_id)
    WHERE id = v_open.id;
  ELSE
    INSERT INTO callback_requests
      (account_id, contact_id, conversation_id, source, source_kind, priority, assigned_caller_id, source_message_id, ai_meta)
    VALUES (p_account_id, p_contact_id, p_conversation_id, left(p_text, 200), 'ai_inbox_text', 'high', v_caller, p_message_id, p_meta);
  END IF;

  PERFORM public.notify_callback_owner(p_account_id, p_contact_id, p_conversation_id, v_caller,
    'callback_requested', 'Priority callback request');
  RETURN CASE WHEN v_open.id IS NOT NULL THEN 'upgraded' ELSE 'created' END;
END;
$$;
ALTER FUNCTION public.open_callback_from_intent(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.open_callback_from_intent(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.open_callback_from_intent(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB) TO service_role;
