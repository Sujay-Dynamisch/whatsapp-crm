-- ============================================================
-- 089: Who wrote a callback's note, and when — shown on the Callbacks
-- page so owners/admins can see what the caller recorded.
-- Additive; no behaviour change for any account. Idempotent.
-- ============================================================

ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS note_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE callback_requests ADD COLUMN IF NOT EXISTS note_at TIMESTAMPTZ;
