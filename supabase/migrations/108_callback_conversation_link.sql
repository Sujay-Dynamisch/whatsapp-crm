-- ============================================================
-- 108: every callback request links to the lead's chat.
--
-- Requests opened by the engagement / tag rules (and the tag upgrade path)
-- were saved without conversation_id, so the Callbacks card showed no
-- "Open chat" button although the lead had a chat. One rule for every
-- writer: a request without a chat gets the contact's latest one, and a
-- chat created later fills requests still missing it. Backfills old rows.
-- ============================================================

CREATE OR REPLACE FUNCTION public.callback_fill_conversation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.conversation_id IS NULL THEN
    SELECT id INTO NEW.conversation_id FROM conversations
    WHERE contact_id = NEW.contact_id
    ORDER BY last_message_at DESC NULLS LAST
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_callback_fill_conversation ON callback_requests;
CREATE TRIGGER trg_callback_fill_conversation
  BEFORE INSERT OR UPDATE OF conversation_id, contact_id ON callback_requests
  FOR EACH ROW EXECUTE FUNCTION public.callback_fill_conversation();

CREATE OR REPLACE FUNCTION public.conversation_fill_callbacks()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE callback_requests SET conversation_id = NEW.id
  WHERE contact_id = NEW.contact_id AND conversation_id IS NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversation_fill_callbacks ON conversations;
CREATE TRIGGER trg_conversation_fill_callbacks
  AFTER INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversation_fill_callbacks();

-- Backfill.
UPDATE callback_requests cr
SET conversation_id = (
  SELECT c.id FROM conversations c
  WHERE c.contact_id = cr.contact_id
  ORDER BY c.last_message_at DESC NULLS LAST
  LIMIT 1
)
WHERE cr.conversation_id IS NULL
  AND EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id = cr.contact_id);
