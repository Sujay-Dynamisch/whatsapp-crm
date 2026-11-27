// ============================================================
// "Add the next webinar session" — one source of truth for:
//   * the header warning (admins),
//   * the Webinars page banner,
//   * the 1 PM / 2 PM admin reminders (minute job, runWebinarGapAlerts),
// so they always agree.
//
// Gap = tomorrow (IST) has no scheduled session, or leads are queued at
// the journey's 'wait_session' step (registered when no session could be
// booked — they get their registration message once a session is added).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { accountHasFeature } from '@/lib/features-server';

const IST_MS = 5.5 * 3600e3;
const DAY_MS = 864e5;
/** The journey step queued leads wait at (scripts/swapnil/journey-graph.ts). */
export const QUEUE_NODE_ID = 'wait_session';

export interface WebinarGap {
  /** Tomorrow (IST) has no scheduled session. */
  nextDayMissing: boolean;
  /** "Sat, 28 Nov" — the day that needs a session. */
  nextDayLabel: string;
  /** Leads waiting for a session to be scheduled. */
  queued: number;
}

/** IST calendar day boundaries (as UTC instants) `offset` days from now. */
function istDay(now: Date, offset: number): { from: Date; to: Date; label: string } {
  const istMidnight = Math.floor((now.getTime() + IST_MS) / DAY_MS) * DAY_MS + offset * DAY_MS;
  const from = new Date(istMidnight - IST_MS);
  const label = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' }).format(
    new Date(from.getTime() + 12 * 3600e3)
  );
  return { from, to: new Date(from.getTime() + DAY_MS), label };
}

export async function webinarGap(db: SupabaseClient, accountId: string, now = new Date()): Promise<WebinarGap> {
  const tomorrow = istDay(now, 1);
  const [{ count: sessions }, { count: queued }] = await Promise.all([
    db
      .from('webinar_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('status', 'scheduled')
      .gte('starts_at', tomorrow.from.toISOString())
      .lt('starts_at', tomorrow.to.toISOString()),
    db
      .from('journey_enrollments')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('status', 'waiting')
      .eq('current_node_id', QUEUE_NODE_ID),
  ]);
  return { nextDayMissing: (sessions ?? 0) === 0, nextDayLabel: tomorrow.label, queued: queued ?? 0 };
}

/**
 * Minute job: remind admins to add the next session — at 1 PM and 2 PM IST
 * (before / at the 2 PM registration cut-off) when tomorrow has none, and
 * whenever leads are queued (at most every 3 h). Never throws.
 */
export async function runWebinarGapAlerts(db: SupabaseClient, now = new Date()): Promise<{ alerted: number }> {
  let alerted = 0;
  try {
    const ist = new Date(now.getTime() + IST_MS);
    const slot = (ist.getUTCHours() === 13 || ist.getUTCHours() === 14) && ist.getUTCMinutes() < 10;
    // Accounts actively using the schedule (a session in the last 30 days or ahead).
    const { data: rows } = await db
      .from('webinar_sessions')
      .select('account_id')
      .gte('starts_at', new Date(now.getTime() - 30 * DAY_MS).toISOString())
      .limit(1000);
    for (const accountId of new Set((rows ?? []).map((r) => r.account_id as string))) {
      if (!(await accountHasFeature(db, accountId, 'webinar_schedule'))) continue;
      const gap = await webinarGap(db, accountId, now);
      const title =
        gap.queued > 0
          ? `${gap.queued} lead${gap.queued === 1 ? ' is' : 's are'} waiting — add the next webinar session`
          : `Add the webinar session for ${gap.nextDayLabel}`;
      const due = (slot && (gap.nextDayMissing || gap.queued > 0)) || gap.queued > 0;
      if (!due) continue;
      // Once per slot (1 PM, 2 PM); queued-only alerts at most every 3 h.
      const since = new Date(now.getTime() - (slot ? 50 : 180) * 60e3).toISOString();
      const { count } = await db
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('type', 'health_alert')
        .ilike('title', '%webinar session%')
        .gte('created_at', since);
      if ((count ?? 0) > 0) continue;
      const { data: admins } = await db.from('profiles').select('user_id').eq('account_id', accountId).in('account_role', ['owner', 'admin']);
      if (!admins?.length) continue;
      await db.from('notifications').insert(
        admins.map((a) => ({
          account_id: accountId,
          user_id: a.user_id,
          type: 'health_alert',
          title,
          body: `Open Webinars and schedule ${gap.nextDayMissing ? gap.nextDayLabel : 'the next session'} — leads registering now are waiting for it.`,
        }))
      );
      alerted++;
    }
  } catch (err) {
    console.warn('[webinar gap alerts] failed:', err instanceof Error ? err.message : err);
  }
  return { alerted };
}
