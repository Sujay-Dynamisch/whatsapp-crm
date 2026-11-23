-- ============================================================
-- 099: Callback timeline.
--
--   callback_events  one row per thing that happened to a callback
--                    request: status changes (Called / No answer /
--                    Done / Re-opened), every note (notes are kept, not
--                    overwritten) and payment links sent by the team.
--
-- Written by the server (service role) only. Readable by anyone who can
-- see the parent request — the EXISTS below runs with the reader's RLS
-- on callback_requests, so callers still see only their own requests.
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS callback_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  callback_id  UUID NOT NULL REFERENCES callback_requests(id) ON DELETE CASCADE,
  contact_id   UUID REFERENCES contacts(id) ON DELETE CASCADE,
  -- 'status' | 'note' | 'payment_link'
  kind         TEXT NOT NULL CHECK (kind IN ('status', 'note', 'payment_link')),
  -- status: the new status; payment_link: 'text' | 'template'
  value        TEXT,
  detail       TEXT,
  actor_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_callback_events_callback ON callback_events (callback_id, created_at);
CREATE INDEX IF NOT EXISTS idx_callback_events_contact ON callback_events (contact_id, created_at);

ALTER TABLE callback_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS callback_events_select ON callback_events;
CREATE POLICY callback_events_select ON callback_events FOR SELECT TO authenticated
  USING (
    is_account_member(account_id)
    AND EXISTS (SELECT 1 FROM callback_requests c WHERE c.id = callback_events.callback_id)
  );

-- Keep the existing single note of each request as its first timeline note.
INSERT INTO callback_events (account_id, callback_id, contact_id, kind, detail, actor_id, created_at)
SELECT c.account_id, c.id, c.contact_id, 'note', c.note, c.note_by, COALESCE(c.note_at, c.updated_at, c.requested_at)
FROM callback_requests c
WHERE c.note IS NOT NULL AND btrim(c.note) <> ''
  AND NOT EXISTS (SELECT 1 FROM callback_events e WHERE e.callback_id = c.id AND e.kind = 'note');
