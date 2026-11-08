-- ============================================================
-- 055: contacts.created_at_ist — when the contact was added, as an
-- India Standard Time wall-clock (e.g. 2026-10-23 15:30:00).
--
-- created_at stays the source of truth (timestamptz, an absolute
-- instant). created_at_ist is kept in sync by a trigger on every insert
-- (and if created_at is ever changed), so journeys can read the IST
-- time directly as {{ contact.created_at_ist }} without converting.
-- ============================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS created_at_ist timestamp without time zone;

CREATE OR REPLACE FUNCTION public.contacts_set_created_at_ist()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_at_ist := COALESCE(NEW.created_at, now()) AT TIME ZONE 'Asia/Kolkata';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contacts_created_at_ist ON public.contacts;
CREATE TRIGGER contacts_created_at_ist
  BEFORE INSERT OR UPDATE OF created_at ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_set_created_at_ist();

-- Backfill existing contacts.
UPDATE public.contacts
SET created_at_ist = created_at AT TIME ZONE 'Asia/Kolkata'
WHERE created_at_ist IS NULL;
