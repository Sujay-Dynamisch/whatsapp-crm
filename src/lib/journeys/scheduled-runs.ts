// ============================================================
// Schedule trigger runner (migration 054). Called from the journey
// tick: claims due 'schedule' journeys, starts a run for every contact
// with the audience tag (unsubscribed contacts skipped), and books the
// next run time.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { getUnsubscribedContactIds } from '@/lib/contacts/unsubscribe';

import { findTrigger } from './graph';
import { enrollContact, startContext, type JourneyDeps, type JourneyRow } from './engine';
import { nextScheduleTime } from './schedule';

/** Contacts started per schedule run (same cap as manual enrollment). */
export const MAX_SCHEDULE_AUDIENCE = 500;

export async function runDueSchedules(
  db: SupabaseClient,
  deps: JourneyDeps
): Promise<{ ran: number; enrolled: number }> {
  const { data, error } = await db.rpc('claim_scheduled_journeys', { p_limit: 20 });
  if (error) throw new Error(`claim_scheduled_journeys failed: ${error.message}`);

  let ran = 0;
  let enrolled = 0;
  for (const journey of (data ?? []) as JourneyRow[]) {
    const now = deps.now();
    const cfg = findTrigger(journey.graph)?.config ?? journey.trigger_config ?? {};
    try {
      if (cfg.tag_id) {
        const { data: rows } = await db
          .from('contact_tags')
          .select('contact_id, contacts!inner(account_id)')
          .eq('tag_id', cfg.tag_id)
          .eq('contacts.account_id', journey.account_id)
          .limit(MAX_SCHEDULE_AUDIENCE);
        const unsubscribed = await getUnsubscribedContactIds(db, journey.account_id);
        const ids = [...new Set((rows ?? []).map((r) => r.contact_id as string))].filter((id) => !unsubscribed.has(id));
        for (const contactId of ids) {
          const r = await enrollContact(db, journey, contactId, deps, startContext('schedule', { scheduled_at: now.toISOString() }));
          if (r.enrolled) enrolled++;
        }
      }
      ran++;
    } finally {
      // Always book the next run, so one bad run can't stall the schedule.
      const next = nextScheduleTime(cfg, now);
      await db
        .from('journeys')
        .update({ next_scheduled_at: next ? next.toISOString() : null })
        .eq('id', journey.id);
    }
  }
  return { ran, enrolled };
}
