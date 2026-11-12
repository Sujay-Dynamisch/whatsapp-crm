-- ============================================================
-- 087: Caller management Phases 2–3 (only accounts with the
-- 'caller_management' feature — Swapnil Gautam's; everyone else is
-- untouched).
--
--   * callback_settings         admin reminder policy + AI threshold
--   * callback_requests         + reminder schedule, AI metadata, evidence
--   * schedule_callback_reminder  BEFORE trigger: (re)computes
--                               next_reminder_at; done/called cancels it
--   * open_callback_from_intent()  AI-detected typed request → priority
--                               task (idempotent by message id); an open
--                               priority task gets the message as evidence;
--                               ambiguous → normal "needs review" task
--   * payment_link_state        one payment-link send per engagement
--
-- Idempotent — safe to re-run.
-- ============================================================

-- 1. Reminder policy -----------------------------------------------------
CREATE TABLE IF NOT EXISTS callback_settings (
  account_id              UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  priority_initial_min    INTEGER NOT NULL DEFAULT 15  CHECK (priority_initial_min BETWEEN 1 AND 10080),
  priority_repeat_min     INTEGER NOT NULL DEFAULT 30  CHECK (priority_repeat_min BETWEEN 5 AND 10080),
  priority_max_reminders  INTEGER NOT NULL DEFAULT 3   CHECK (priority_max_reminders BETWEEN 0 AND 50),
  standard_initial_min    INTEGER NOT NULL DEFAULT 240 CHECK (standard_initial_min BETWEEN 1 AND 10080),
  standard_repeat_min     INTEGER NOT NULL DEFAULT 240 CHECK (standard_repeat_min BETWEEN 5 AND 10080),
  standard_max_reminders  INTEGER NOT NULL DEFAULT 1   CHECK (standard_max_reminders BETWEEN 0 AND 50),
  window_start_hour       INTEGER NOT NULL DEFAULT 9   CHECK (window_start_hour BETWEEN 0 AND 23),
  window_end_hour         INTEGER NOT NULL DEFAULT 21  CHECK (window_end_hour BETWEEN 1 AND 24),
  -- ISO weekday numbers, 1 = Monday … 7 = Sunday.
  window_days             INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6],
  timezone                TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  escalate_to             TEXT NOT NULL DEFAULT 'admins' CHECK (escalate_to IN ('admins', 'none')),
  repeat_until_handled    BOOLEAN NOT NULL DEFAULT FALSE,
  ai_detection_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  ai_confidence_threshold NUMERIC(3,2) NOT NULL DEFAULT 0.75 CHECK (ai_confidence_threshold BETWEEN 0.30 AND 1.00),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE callback_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS callback_settings_select ON callback_settings;
CREATE POLICY callback_settings_select ON callback_settings FOR SELECT USING (is_account_member(account_id));
-- Writes: service role after the Callers-area check (API).

ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS next_reminder_at TIMESTAMPTZ;
ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMPTZ;
ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
-- { confidence, language, requested_time, reason, model }
ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS ai_meta JSONB;
-- Later messages on the same open request: [{ message_id, text, at, confidence }]
ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_callback_requests_reminder ON callback_requests (next_reminder_at) WHERE next_reminder_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_callback_requests_source_message
  ON callback_requests (account_id, source_message_id) WHERE source_message_id IS NOT NULL;

-- 2. Reminder schedule (managed accounts only) ---------------------------
CREATE OR REPLACE FUNCTION public.schedule_callback_reminder()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s callback_settings%ROWTYPE;
  v_mins INTEGER;
BEGIN
  IF NOT public.account_has_feature(NEW.account_id, 'caller_management') THEN
    RETURN NEW;
  END IF;
  -- Handled / closed: cancel pending reminders.
  IF NEW.status IN ('done', 'called') THEN
    NEW.next_reminder_at := NULL;
    RETURN NEW;
  END IF;
  SELECT * INTO s FROM callback_settings WHERE account_id = NEW.account_id;

  IF TG_OP = 'INSERT'
     OR NEW.priority IS DISTINCT FROM OLD.priority
     OR OLD.status IN ('done', 'called') THEN
    -- New / upgraded / re-opened: start the schedule over.
    NEW.reminder_count := 0;
    NEW.escalated_at := NULL;
    v_mins := CASE WHEN NEW.priority = 'high' THEN COALESCE(s.priority_initial_min, 15) ELSE COALESCE(s.standard_initial_min, 240) END;
    NEW.next_reminder_at := NOW() + make_interval(mins => v_mins);
  ELSIF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.assigned_caller_id IS DISTINCT FROM OLD.assigned_caller_id THEN
    -- Another attempt ("No answer") or a new owner: next reminder after the repeat interval.
    v_mins := CASE WHEN NEW.priority = 'high' THEN COALESCE(s.priority_repeat_min, 30) ELSE COALESCE(s.standard_repeat_min, 240) END;
    NEW.next_reminder_at := NOW() + make_interval(mins => v_mins);
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.schedule_callback_reminder() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_callback_schedule_reminder ON callback_requests;
CREATE TRIGGER on_callback_schedule_reminder
  BEFORE INSERT OR UPDATE OF status, priority, assigned_caller_id ON callback_requests
  FOR EACH ROW EXECUTE FUNCTION public.schedule_callback_reminder();

-- 3. Notify the request's caller, or owners/admins when unassigned ------
CREATE OR REPLACE FUNCTION public.notify_callback_owner(
  p_account_id UUID, p_contact_id UUID, p_conversation_id UUID, p_caller UUID, p_type TEXT, p_title TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label TEXT;
BEGIN
  SELECT COALESCE(NULLIF(name, ''), phone)
           || CASE WHEN COALESCE(NULLIF(name, ''), phone) <> phone THEN ' · ' || phone ELSE '' END
    INTO v_label FROM contacts WHERE id = p_contact_id;
  IF p_caller IS NOT NULL THEN
    INSERT INTO notifications (account_id, user_id, type, conversation_id, contact_id, title, body)
    VALUES (p_account_id, p_caller, p_type, p_conversation_id, p_contact_id, p_title, v_label);
  ELSE
    INSERT INTO notifications (account_id, user_id, type, conversation_id, contact_id, title, body)
    SELECT p_account_id, p.user_id, p_type, p_conversation_id, p_contact_id, p_title || ' (unassigned)', v_label
    FROM profiles p WHERE p.account_id = p_account_id AND p.account_role IN ('owner', 'admin');
  END IF;
END;
$$;
ALTER FUNCTION public.notify_callback_owner(UUID, UUID, UUID, UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_callback_owner(UUID, UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_callback_owner(UUID, UUID, UUID, UUID, TEXT, TEXT) TO service_role;

-- 4. AI-detected typed callback request ----------------------------------
-- Returns 'created' | 'upgraded' | 'attached' | 'review' | 'duplicate' | 'off'.
-- Never creates a registration or engagement.
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

-- 5. Payment link: at most once per engagement ---------------------------
CREATE TABLE IF NOT EXISTS payment_link_state (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id    UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  engagement_id UUID REFERENCES engagements(id) ON DELETE CASCADE,
  -- engagement id, or 'contact:<id>' for a lead from before engagements.
  idem_key      TEXT NOT NULL,
  journey_id    UUID,
  node_id       TEXT,
  status        TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'sent')),
  wa_message_id TEXT,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, idem_key)
);
ALTER TABLE payment_link_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_link_state_select ON payment_link_state;
CREATE POLICY payment_link_state_select ON payment_link_state FOR SELECT USING (is_account_member(account_id));
