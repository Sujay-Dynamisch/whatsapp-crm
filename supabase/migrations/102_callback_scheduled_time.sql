-- ============================================================
-- 102: The time a customer asked to be called.
--
--   callback_requests.scheduled_for          when to call (customer's
--                                            choice, e.g. "12:30 tomorrow")
--   callback_requests.scheduled_reminded_at  when the caller was told
--                                            "time to call" (once)
--
-- The AI callback detector (src/lib/callbacks/intent.ts) now reads the
-- conversation and resolves a named time into p_meta.scheduled_for; this
-- version of open_callback_from_intent stores it — on a new or upgraded
-- priority request, and also when the customer gives / changes the time
-- for a request that is already open. The minute job reminds the caller
-- at that time; regular reminders wait until then.
-- Idempotent — safe to re-run. Requires 101.
-- ============================================================

ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS scheduled_reminded_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_callback_requests_scheduled
  ON callback_requests (scheduled_for) WHERE status <> 'done' AND scheduled_for IS NOT NULL AND scheduled_reminded_at IS NULL;

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
  v_sched   TIMESTAMPTZ;
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

  -- The time they asked to be called (102). Bad / past / far values are ignored.
  BEGIN
    v_sched := NULLIF(p_meta ->> 'scheduled_for', '')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    v_sched := NULL;
  END;
  IF v_sched IS NOT NULL AND (v_sched < NOW() - INTERVAL '1 hour' OR v_sched > NOW() + INTERVAL '30 days') THEN
    v_sched := NULL;
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
      UPDATE callback_requests
      SET evidence = evidence || v_ev, updated_at = NOW(),
          scheduled_for = COALESCE(v_sched, scheduled_for),
          scheduled_reminded_at = CASE WHEN v_sched IS NOT NULL THEN NULL ELSE scheduled_reminded_at END
      WHERE id = v_open.id;
      RETURN 'attached';
    END IF;
    -- Ambiguous: a normal task for a human to review; no priority, no alert.
    INSERT INTO callback_requests
      (account_id, contact_id, conversation_id, source, source_kind, priority, assigned_caller_id, source_message_id, ai_meta, scheduled_for)
    VALUES (p_account_id, p_contact_id, p_conversation_id, left(p_text, 200), 'ai_review', 'normal', v_caller, p_message_id, p_meta, v_sched)
    ON CONFLICT DO NOTHING;
    RETURN 'review';
  END IF;

  IF v_open.id IS NOT NULL AND v_open.priority = 'high' THEN
    -- Already a priority request: keep it, but record a new / changed time.
    UPDATE callback_requests
    SET evidence = evidence || v_ev, updated_at = NOW(),
        scheduled_for = COALESCE(v_sched, scheduled_for),
        scheduled_reminded_at = CASE WHEN v_sched IS NOT NULL THEN NULL ELSE scheduled_reminded_at END,
        ai_meta = CASE WHEN v_sched IS NOT NULL THEN COALESCE(ai_meta, '{}'::jsonb) || jsonb_build_object('requested_time', p_meta -> 'requested_time') ELSE ai_meta END
    WHERE id = v_open.id;
    IF v_sched IS NOT NULL AND v_sched IS DISTINCT FROM v_open.scheduled_for THEN
      PERFORM public.notify_callback_owner(p_account_id, p_contact_id, p_conversation_id, v_open.assigned_caller_id,
        'callback_requested', 'Callback time set: ' || to_char(v_sched AT TIME ZONE 'Asia/Kolkata', 'Dy DD Mon, HH12:MI AM') || ' IST');
      RETURN 'rescheduled';
    END IF;
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
        conversation_id = COALESCE(conversation_id, p_conversation_id),
        scheduled_for = COALESCE(v_sched, scheduled_for), scheduled_reminded_at = NULL
    WHERE id = v_open.id;
  ELSE
    INSERT INTO callback_requests
      (account_id, contact_id, conversation_id, source, source_kind, priority, assigned_caller_id, source_message_id, ai_meta, scheduled_for)
    VALUES (p_account_id, p_contact_id, p_conversation_id, left(p_text, 200), 'ai_inbox_text', 'high', v_caller, p_message_id, p_meta, v_sched);
  END IF;

  PERFORM public.notify_callback_owner(p_account_id, p_contact_id, p_conversation_id, v_caller,
    'callback_requested',
    CASE WHEN v_sched IS NOT NULL
         THEN 'Priority callback at ' || to_char(v_sched AT TIME ZONE 'Asia/Kolkata', 'Dy DD Mon, HH12:MI AM') || ' IST'
         ELSE 'Priority callback request' END);
  RETURN CASE WHEN v_open.id IS NOT NULL THEN 'upgraded' ELSE 'created' END;
END;
$$;
ALTER FUNCTION public.open_callback_from_intent(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.open_callback_from_intent(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.open_callback_from_intent(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB) TO service_role;
