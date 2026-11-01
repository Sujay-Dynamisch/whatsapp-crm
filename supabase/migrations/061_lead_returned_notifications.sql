-- ============================================================
-- 061: 'lead_returned' notifications — a closed-lost (or closed) lead
-- wrote back on WhatsApp (src/lib/journeys/revive.ts). Owners, admins
-- and the chat's assignee are told; clicking opens the chat.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned', 'callback_requested', 'callback_overdue', 'callback_returned',
    'health_alert', 'health_summary', 'lead_returned'
  ));
