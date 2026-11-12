-- ============================================================
-- 086: Caller management (CRM & Customer Engagement spec, Phase 1).
--
-- Off-by-default account feature 'caller_management' — on only for
-- Swapnil Gautam's account. While it is off for an account, nothing in
-- this file changes that account's behaviour:
--
--   * callers                    team members who take leads (active /
--                                inactive, lead-eligible)
--   * engagements                one row per ACCEPTED website
--                                registration; 15-day repeat rule
--   * caller_assignment_history  every owner change (audit)
--   * round_robin_state          persisted rotation cursor
--   * contacts.assigned_caller_id     current owner of the customer
--   * callback_requests          + priority / owner / engagement / kind
--   * accept_registration()      atomic dedupe + assign + follow-up task
--   * open_callback_request()    a real callback request upgrades the
--                                lead's task to HIGH priority and
--                                notifies its caller (else admins)
--   * restrictive RLS            a non-admin caller only reads their
--                                own customers, chats and callbacks
--
-- Idempotent — safe to re-run.
-- ============================================================

-- 1. Feature: off for every account except Swapnil's ---------------------
UPDATE accounts
SET disabled_features = array_append(disabled_features, 'caller_management')
WHERE id <> 'ba23ef90-3416-44c9-84dd-b3b859d4d021'
  AND NOT ('caller_management' = ANY (disabled_features));

CREATE OR REPLACE FUNCTION public.accounts_default_off_features()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['failed_messages', 'payments', 'caller_management'] LOOP
    IF NOT (f = ANY (NEW.disabled_features)) THEN
      NEW.disabled_features := array_append(NEW.disabled_features, f);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.accounts_default_off_features() OWNER TO postgres;

-- 2. Tables -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS callers (
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  lead_eligible BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, user_id)
);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS assigned_caller_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_assigned_caller ON contacts (assigned_caller_id) WHERE assigned_caller_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS engagements (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id         UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  registration_id    TEXT,
  source             TEXT NOT NULL DEFAULT 'website',
  accepted_at        TIMESTAMPTZ NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  assigned_caller_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  closed_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_engagements_registration ON engagements (account_id, registration_id) WHERE registration_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_engagements_contact ON engagements (contact_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS idx_engagements_caller ON engagements (account_id, assigned_caller_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS caller_assignment_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id     UUID REFERENCES contacts(id) ON DELETE CASCADE,
  engagement_id  UUID REFERENCES engagements(id) ON DELETE CASCADE,
  from_caller_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  to_caller_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reason         TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_caller_history_contact ON caller_assignment_history (contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS round_robin_state (
  account_id     UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_caller_id UUID,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE callback_requests DROP CONSTRAINT IF EXISTS callback_requests_priority_check;
ALTER TABLE callback_requests ADD CONSTRAINT callback_requests_priority_check CHECK (priority IN ('normal', 'high'));
ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS assigned_caller_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS engagement_id UUID REFERENCES engagements(id) ON DELETE SET NULL;
-- engagement (default follow-up) | whatsapp_button | tag | ai_inbox_text
ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS source_kind TEXT;
ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS source_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_callback_requests_caller ON callback_requests (assigned_caller_id) WHERE status <> 'done';

-- Notifications learn 'callback_assigned' (a lead / callback was given to you).
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned', 'callback_requested', 'callback_overdue', 'callback_returned',
    'health_alert', 'health_summary', 'lead_returned',
    'payment_click', 'message_failed', 'window_closing',
    'callback_assigned'
  ));

-- 3. RLS on the new tables (members read; admins write; feature-gated) ----
ALTER TABLE callers ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagements ENABLE ROW LEVEL SECURITY;
ALTER TABLE caller_assignment_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE round_robin_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS callers_select ON callers;
CREATE POLICY callers_select ON callers FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS callers_write ON callers;
CREATE POLICY callers_write ON callers FOR ALL
  USING (is_account_member(account_id, 'admin')) WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS engagements_select ON engagements;
CREATE POLICY engagements_select ON engagements FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS caller_history_select ON caller_assignment_history;
CREATE POLICY caller_history_select ON caller_assignment_history FOR SELECT USING (is_account_member(account_id));
-- round_robin_state: no client policies (service role / definer functions only).

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['callers', 'engagements', 'caller_assignment_history'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS feature_gate_select ON public.%I', tbl);
    EXECUTE format('CREATE POLICY feature_gate_select ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated
      USING (public.account_has_feature(account_id, %L))', tbl, 'caller_management');
  END LOOP;
END $$;

-- Custom roles (079): the 'callers' area gates writes and reads.
DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN
    SELECT * FROM (VALUES
      ('callers',                    'callers',         true),
      ('caller_assignment_history',  'callers',         true)
    ) AS t(tbl, area, gate_reads)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS perm_gate_insert ON public.%I', g.tbl);
    EXECUTE format('CREATE POLICY perm_gate_insert ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated
      WITH CHECK ((SELECT public.my_area_level(%L)) >= 2)', g.tbl, g.area);
    EXECUTE format('DROP POLICY IF EXISTS perm_gate_update ON public.%I', g.tbl);
    EXECUTE format('CREATE POLICY perm_gate_update ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated
      USING ((SELECT public.my_area_level(%L)) >= 2)', g.tbl, g.area);
    EXECUTE format('DROP POLICY IF EXISTS perm_gate_delete ON public.%I', g.tbl);
    EXECUTE format('CREATE POLICY perm_gate_delete ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated
      USING ((SELECT public.my_area_level(%L)) >= 2)', g.tbl, g.area);
    EXECUTE format('DROP POLICY IF EXISTS perm_gate_select ON public.%I', g.tbl);
    IF g.gate_reads THEN
      EXECUTE format('CREATE POLICY perm_gate_select ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated
        USING ((SELECT public.my_area_level(%L)) >= 1)', g.tbl, g.area);
    END IF;
  END LOOP;
END $$;

-- 4. Is the signed-in user a scoped (non-admin) caller? ------------------
CREATE OR REPLACE FUNCTION public.my_caller_restricted()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    JOIN callers c ON c.account_id = p.account_id AND c.user_id = p.user_id
    WHERE p.user_id = auth.uid()
      AND p.account_role NOT IN ('owner', 'admin')
      AND public.account_has_feature(p.account_id, 'caller_management')
  );
$$;
ALTER FUNCTION public.my_caller_restricted() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.my_caller_restricted() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_caller_restricted() TO authenticated, service_role;

-- Scoped callers see only their own customers / chats / callbacks / payments.
-- (SELECT …) makes Postgres evaluate the check once per query.
DROP POLICY IF EXISTS caller_scope_select ON contacts;
CREATE POLICY caller_scope_select ON contacts AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT (SELECT public.my_caller_restricted()) OR assigned_caller_id = auth.uid());

DROP POLICY IF EXISTS caller_scope_select ON conversations;
CREATE POLICY caller_scope_select ON conversations AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    NOT (SELECT public.my_caller_restricted())
    OR assigned_agent_id = auth.uid()
    OR EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = conversations.contact_id)
  );

DROP POLICY IF EXISTS caller_scope_select ON messages;
CREATE POLICY caller_scope_select ON messages AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    NOT (SELECT public.my_caller_restricted())
    OR EXISTS (SELECT 1 FROM conversations cv WHERE cv.id = messages.conversation_id)
  );

DROP POLICY IF EXISTS caller_scope_select ON callback_requests;
CREATE POLICY caller_scope_select ON callback_requests AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT (SELECT public.my_caller_restricted()) OR assigned_caller_id = auth.uid());

DROP POLICY IF EXISTS caller_scope_select ON payment_records;
CREATE POLICY caller_scope_select ON payment_records AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    NOT (SELECT public.my_caller_restricted())
    OR EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = payment_records.contact_id)
  );

DROP POLICY IF EXISTS caller_scope_select ON engagements;
CREATE POLICY caller_scope_select ON engagements AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT (SELECT public.my_caller_restricted()) OR assigned_caller_id = auth.uid());

-- 5. Round-robin: next active, lead-eligible caller (locks the cursor) ----
CREATE OR REPLACE FUNCTION public.next_round_robin_caller(p_account_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last UUID;
  v_last_at TIMESTAMPTZ;
  v_next UUID;
BEGIN
  INSERT INTO round_robin_state (account_id) VALUES (p_account_id) ON CONFLICT DO NOTHING;
  SELECT last_caller_id INTO v_last FROM round_robin_state WHERE account_id = p_account_id FOR UPDATE;
  SELECT created_at INTO v_last_at FROM callers WHERE account_id = p_account_id AND user_id = v_last;

  IF v_last_at IS NOT NULL THEN
    SELECT user_id INTO v_next FROM callers
    WHERE account_id = p_account_id AND status = 'active' AND lead_eligible
      AND (created_at, user_id) > (v_last_at, v_last)
    ORDER BY created_at, user_id LIMIT 1;
  END IF;
  IF v_next IS NULL THEN
    SELECT user_id INTO v_next FROM callers
    WHERE account_id = p_account_id AND status = 'active' AND lead_eligible
    ORDER BY created_at, user_id LIMIT 1;
  END IF;

  IF v_next IS NOT NULL THEN
    UPDATE round_robin_state SET last_caller_id = v_next, updated_at = NOW() WHERE account_id = p_account_id;
  END IF;
  RETURN v_next;
END;
$$;
ALTER FUNCTION public.next_round_robin_caller(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.next_round_robin_caller(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_round_robin_caller(UUID) TO service_role;

-- 6. Accept a website registration (atomic) ------------------------------
-- Returns { accepted, reason, engagement_id, assigned_caller_id }.
--   within 15 days of the latest ACCEPTED engagement → not accepted
--   (ignored attempts never move the window). Accepted → new engagement,
--   owner = previous caller if still active+eligible (cursor untouched),
--   else round-robin, else unassigned; plus a normal-priority follow-up
--   task with no notification.
CREATE OR REPLACE FUNCTION public.accept_registration(
  p_account_id UUID,
  p_contact_id UUID,
  p_registration_id TEXT,
  p_registered_at TIMESTAMPTZ,
  p_source TEXT DEFAULT 'website'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last    engagements%ROWTYPE;
  v_dup     UUID;
  v_caller  UUID;
  v_reason  TEXT;
  v_eng     UUID;
  v_conv    UUID;
  v_open    UUID;
BEGIN
  -- One registration at a time per contact.
  PERFORM pg_advisory_xact_lock(hashtextextended('engagement:' || p_contact_id::text, 0));

  IF p_registration_id IS NOT NULL THEN
    SELECT id INTO v_dup FROM engagements WHERE account_id = p_account_id AND registration_id = p_registration_id;
    IF v_dup IS NOT NULL THEN
      RETURN jsonb_build_object('accepted', false, 'reason', 'duplicate', 'engagement_id', v_dup);
    END IF;
  END IF;

  SELECT * INTO v_last FROM engagements WHERE contact_id = p_contact_id ORDER BY accepted_at DESC LIMIT 1;
  IF v_last.id IS NOT NULL AND p_registered_at < v_last.accepted_at + INTERVAL '15 days' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'within_15_days', 'engagement_id', v_last.id);
  END IF;

  IF v_last.id IS NOT NULL AND v_last.assigned_caller_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM callers
    WHERE account_id = p_account_id AND user_id = v_last.assigned_caller_id AND status = 'active' AND lead_eligible
  ) THEN
    v_caller := v_last.assigned_caller_id;
    v_reason := 'REENGAGEMENT_SAME_CALLER';
  ELSE
    v_caller := public.next_round_robin_caller(p_account_id);
    v_reason := CASE
      WHEN v_caller IS NULL THEN 'UNASSIGNED_NO_ELIGIBLE_CALLER'
      WHEN v_last.id IS NULL THEN 'ROUND_ROBIN'
      ELSE 'REENGAGEMENT_FALLBACK_ROUND_ROBIN'
    END;
  END IF;

  UPDATE engagements SET status = 'closed', closed_at = NOW() WHERE contact_id = p_contact_id AND status = 'open';
  INSERT INTO engagements (account_id, contact_id, registration_id, source, accepted_at, assigned_caller_id)
  VALUES (p_account_id, p_contact_id, p_registration_id, COALESCE(p_source, 'website'), p_registered_at, v_caller)
  RETURNING id INTO v_eng;

  INSERT INTO caller_assignment_history (account_id, contact_id, engagement_id, from_caller_id, to_caller_id, reason)
  VALUES (p_account_id, p_contact_id, v_eng, v_last.assigned_caller_id, v_caller, v_reason);

  UPDATE contacts SET assigned_caller_id = v_caller WHERE id = p_contact_id;

  -- Default follow-up task (no notification).
  SELECT id INTO v_open FROM callback_requests WHERE contact_id = p_contact_id AND status <> 'done' LIMIT 1;
  IF v_open IS NULL THEN
    SELECT id INTO v_conv FROM conversations WHERE contact_id = p_contact_id
    ORDER BY last_message_at DESC NULLS LAST LIMIT 1;
    INSERT INTO callback_requests
      (account_id, contact_id, conversation_id, source, source_kind, priority, assigned_caller_id, engagement_id, requested_at)
    VALUES
      (p_account_id, p_contact_id, v_conv, 'New registration', 'engagement', 'normal', v_caller, v_eng, p_registered_at)
    ON CONFLICT DO NOTHING;
  ELSE
    UPDATE callback_requests SET assigned_caller_id = v_caller, engagement_id = v_eng, updated_at = NOW() WHERE id = v_open;
  END IF;

  RETURN jsonb_build_object('accepted', true, 'reason', v_reason, 'engagement_id', v_eng, 'assigned_caller_id', v_caller);
END;
$$;
ALTER FUNCTION public.accept_registration(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accept_registration(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_registration(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT) TO service_role;

-- 7. Callback tag trigger: unchanged for other accounts; with
--    caller_management a real request is HIGH priority, owned by the
--    customer's caller, and notifies that caller (admins if unassigned).
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
    -- Owner = the customer's caller while that caller is active.
    SELECT c.user_id INTO v_caller FROM callers c
    WHERE c.account_id = v_contact.account_id AND c.user_id = v_contact.assigned_caller_id AND c.status = 'active';

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

DROP TRIGGER IF EXISTS on_callback_tag_added ON contact_tags;
CREATE TRIGGER on_callback_tag_added
  AFTER INSERT ON contact_tags
  FOR EACH ROW EXECUTE FUNCTION open_callback_request();
