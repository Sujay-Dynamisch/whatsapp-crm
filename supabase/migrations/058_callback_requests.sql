-- ============================================================
-- 058: callback_requests — "please call me" requests to work through.
--
-- A request opens whenever a contact gets the `callback_requested` tag,
-- whatever added it (journey step, automation, an agent). One open
-- request per contact; marking it Done removes the tag (API) so a later
-- request opens a new row. Each new request notifies the account's
-- owner and admins (notifications type 'callback_requested').
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS callback_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'called', 'no_answer', 'done')),
  -- What the contact did: the button they tapped / message they sent.
  source          TEXT,
  note            TEXT,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  handled_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  handled_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_callback_requests_account_time
  ON callback_requests (account_id, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_callback_requests_one_open
  ON callback_requests (contact_id) WHERE status <> 'done';

ALTER TABLE callback_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS callback_requests_select ON callback_requests;
CREATE POLICY callback_requests_select ON callback_requests FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS callback_requests_update ON callback_requests;
CREATE POLICY callback_requests_update ON callback_requests FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

-- Notifications learn a second type.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'callback_requested'));

-- ------------------------------------------------------------
-- Trigger: tag added → open a request + notify owner/admins.
-- ------------------------------------------------------------
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
  v_label     TEXT;
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

  -- Already waiting for a call — don't open a second one.
  IF EXISTS (
    SELECT 1 FROM callback_requests WHERE contact_id = v_contact.id AND status <> 'done'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_conv_id FROM conversations
  WHERE contact_id = v_contact.id
  ORDER BY last_message_at DESC NULLS LAST LIMIT 1;

  -- Best guess at what prompted it: a recent button tap, else their
  -- latest message.
  SELECT COALESCE(button_text, button_payload) INTO v_source FROM button_clicks
  WHERE contact_id = v_contact.id AND clicked_at > NOW() - INTERVAL '15 minutes'
  ORDER BY clicked_at DESC LIMIT 1;
  IF v_source IS NULL AND v_conv_id IS NOT NULL THEN
    SELECT left(content_text, 200) INTO v_source FROM messages
    WHERE conversation_id = v_conv_id AND sender_type = 'customer'
      AND created_at > NOW() - INTERVAL '15 minutes'
    ORDER BY created_at DESC LIMIT 1;
  END IF;

  INSERT INTO callback_requests (account_id, contact_id, conversation_id, source)
  VALUES (v_contact.account_id, v_contact.id, v_conv_id, v_source)
  ON CONFLICT DO NOTHING;

  v_label := COALESCE(NULLIF(v_contact.name, ''), v_contact.phone)
    || CASE WHEN COALESCE(NULLIF(v_contact.name, ''), v_contact.phone) <> v_contact.phone
            THEN ' · ' || v_contact.phone ELSE '' END;

  INSERT INTO notifications (account_id, user_id, type, conversation_id, contact_id, title, body)
  SELECT v_contact.account_id, p.user_id, 'callback_requested', v_conv_id, v_contact.id,
         'Callback request', v_label
  FROM profiles p
  WHERE p.account_id = v_contact.account_id AND p.account_role IN ('owner', 'admin');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let this block tagging.
  RAISE WARNING 'open_callback_request failed for contact %: %', NEW.contact_id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION open_callback_request() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_callback_tag_added ON contact_tags;
CREATE TRIGGER on_callback_tag_added
  AFTER INSERT ON contact_tags
  FOR EACH ROW EXECUTE FUNCTION open_callback_request();

-- Live sidebar badge / page refresh.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'callback_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE callback_requests;
  END IF;
END $$;

-- Contacts already tagged become open requests (no notifications).
INSERT INTO callback_requests (account_id, contact_id, conversation_id, requested_at)
SELECT c.account_id, c.id,
       (SELECT id FROM conversations WHERE contact_id = c.id ORDER BY last_message_at DESC NULLS LAST LIMIT 1),
       COALESCE(ct.created_at, NOW())
FROM contact_tags ct
JOIN tags t ON t.id = ct.tag_id AND lower(t.name) = 'callback_requested'
JOIN contacts c ON c.id = ct.contact_id
ON CONFLICT DO NOTHING;
