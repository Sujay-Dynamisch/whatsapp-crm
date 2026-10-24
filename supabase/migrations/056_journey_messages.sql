-- ============================================================
-- 056: journey_messages — every message a journey run sends, with its
-- delivery outcome, so admins get a per-contact overview.
--
-- One row per send attempt. The WhatsApp status webhook mirrors
-- sent → delivered → read / failed onto the row via wa_message_id.
-- A failed template can be:
--   * retried by the journey tick (kind 'retry', parent_id = failed row)
--     while next_retry_at <= now() < retry_until, or
--   * re-sent as plain text when the customer next messages us and the
--     24-hour window is open (kind 'fallback', parent_id = failed row).
-- `resolved` records what happened to a failed row.
-- Only the service role (engine / webhook) writes; members read.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.journey_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  journey_id     uuid NOT NULL REFERENCES public.journeys(id) ON DELETE CASCADE,
  enrollment_id  uuid NOT NULL REFERENCES public.journey_enrollments(id) ON DELETE CASCADE,
  contact_id     uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  node_id        text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('template', 'text', 'media', 'buttons', 'retry', 'fallback')),
  template_name  text,
  language       text,
  params         jsonb,
  content_text   text,
  wa_message_id  text,
  status         text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  error_code     integer,
  error_title    text,
  error_details  text,
  attempt        integer NOT NULL DEFAULT 1,
  parent_id      uuid REFERENCES public.journey_messages(id) ON DELETE SET NULL,
  retry_until    timestamptz,
  next_retry_at  timestamptz,
  resolved       text CHECK (resolved IN ('retried', 'fallback_sent', 'expired', 'superseded', 'opted_out')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_journey_messages_wamid ON public.journey_messages (wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journey_messages_enrollment ON public.journey_messages (enrollment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_journey_messages_contact_failed ON public.journey_messages (contact_id, created_at)
  WHERE status = 'failed' AND resolved IS NULL;
CREATE INDEX IF NOT EXISTS idx_journey_messages_retry_due ON public.journey_messages (next_retry_at)
  WHERE status = 'failed' AND resolved IS NULL AND next_retry_at IS NOT NULL;

ALTER TABLE public.journey_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS journey_messages_select ON public.journey_messages;
CREATE POLICY journey_messages_select ON public.journey_messages FOR SELECT
  USING (is_account_member(account_id));

DROP TRIGGER IF EXISTS set_updated_at ON public.journey_messages;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.journey_messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
