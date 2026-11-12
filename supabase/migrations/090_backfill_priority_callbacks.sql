-- ============================================================
-- 090: Open callback requests made BEFORE caller management (086) were
-- real customer requests (button tap / tag), but the old trigger had no
-- priority. In caller-managed accounts, mark them Priority so they show
-- in the header, the caller's dashboard and the top of Callbacks.
-- New-lead follow-ups (source_kind = 'engagement') and AI "needs review"
-- tasks are left alone. No notifications are sent. Idempotent.
-- ============================================================

UPDATE callback_requests
SET priority = 'high',
    source_kind = 'whatsapp_button',
    updated_at = NOW()
WHERE status <> 'done'
  AND priority = 'normal'
  AND source_kind IS NULL
  AND public.account_has_feature(account_id, 'caller_management');
