-- ============================================================
-- 046_button_clicks
--
-- Button-click analytics. When a customer taps a quick-reply
-- ("callback") button on a template — standard or carousel — or a
-- reply button / list row on an interactive message, WhatsApp sends
-- the tap to the webhook with `context.id` = the wamid of the message
-- that was tapped. The webhook records one row here per tap, credited
-- to the broadcast (via broadcast_recipients.whatsapp_message_id) or
-- the inbox / bot message (via messages.message_id) it came from.
--
-- URL and phone buttons are NOT reported by WhatsApp, so they can't
-- appear here.
--
-- Gated by the 'button_analytics' account feature (045): the webhook
-- doesn't record while it's off, and reads are blocked by a
-- RESTRICTIVE policy.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS button_clicks (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id             UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id        UUID REFERENCES conversations(id) ON DELETE SET NULL,
  -- Our inbound messages row for the tap. UNIQUE → a replayed webhook
  -- delivery can't count the same tap twice.
  message_id             UUID UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  wa_message_id          TEXT,
  -- wamid of the message whose button was tapped.
  context_wa_message_id  TEXT,
  button_kind            TEXT NOT NULL CHECK (button_kind IN ('template_quick_reply', 'interactive_button', 'interactive_list')),
  button_text            TEXT,
  button_payload         TEXT,
  -- Carousel card, when the payload identifies it (card_<n>_btn_<m>).
  card_index             INTEGER,
  source                 TEXT NOT NULL CHECK (source IN ('broadcast', 'inbox', 'bot', 'unknown')),
  broadcast_id           UUID REFERENCES broadcasts(id) ON DELETE SET NULL,
  broadcast_recipient_id UUID REFERENCES broadcast_recipients(id) ON DELETE SET NULL,
  template_name          TEXT,
  clicked_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_button_clicks_account_clicked
  ON button_clicks (account_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_button_clicks_broadcast
  ON button_clicks (broadcast_id) WHERE broadcast_id IS NOT NULL;

ALTER TABLE button_clicks ENABLE ROW LEVEL SECURITY;

-- Read: account members. Writes: service role only (the webhook) — no
-- INSERT/UPDATE/DELETE policy, so users can't fabricate clicks.
DROP POLICY IF EXISTS button_clicks_select ON button_clicks;
CREATE POLICY button_clicks_select ON button_clicks FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS feature_gate_select ON button_clicks;
CREATE POLICY feature_gate_select ON button_clicks AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.account_has_feature(account_id, 'button_analytics'));

-- ============================================================
-- Summary for the analytics page. SECURITY INVOKER, so RLS (account
-- membership + the feature gate) applies to every row it reads.
-- ============================================================
CREATE OR REPLACE FUNCTION public.button_click_summary(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH c AS (
    SELECT * FROM button_clicks
    WHERE clicked_at >= p_from AND clicked_at < p_to
  )
  SELECT jsonb_build_object(
    'totals', (
      SELECT jsonb_build_object(
        'clicks', COUNT(*),
        'unique_contacts', COUNT(DISTINCT contact_id),
        'from_broadcasts', COUNT(*) FILTER (WHERE source = 'broadcast'),
        'from_inbox', COUNT(*) FILTER (WHERE source = 'inbox'),
        'from_bot', COUNT(*) FILTER (WHERE source = 'bot')
      ) FROM c
    ),
    'by_button', COALESCE((
      SELECT jsonb_agg(row_to_json(b) ORDER BY b.clicks DESC)
      FROM (
        SELECT COALESCE(button_text, button_payload, '(no label)') AS button,
               template_name,
               button_kind,
               COUNT(*) AS clicks,
               COUNT(DISTINCT contact_id) AS unique_contacts,
               MAX(clicked_at) AS last_clicked_at
        FROM c
        GROUP BY 1, 2, 3
        ORDER BY clicks DESC
        LIMIT 200
      ) b
    ), '[]'::jsonb),
    'by_broadcast', COALESCE((
      SELECT jsonb_agg(row_to_json(x) ORDER BY x.clicks DESC)
      FROM (
        SELECT br.id AS broadcast_id,
               br.name,
               br.template_name,
               br.sent_count,
               COUNT(*) AS clicks,
               COUNT(DISTINCT c.broadcast_recipient_id) AS unique_clickers
        FROM c
        JOIN broadcasts br ON br.id = c.broadcast_id
        GROUP BY br.id
        ORDER BY clicks DESC
        LIMIT 200
      ) x
    ), '[]'::jsonb),
    'by_day', COALESCE((
      SELECT jsonb_agg(row_to_json(d) ORDER BY d.day)
      FROM (
        SELECT date_trunc('day', clicked_at)::date AS day, COUNT(*) AS clicks
        FROM c GROUP BY 1
      ) d
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.button_click_summary(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.button_click_summary(TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.button_click_summary(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
