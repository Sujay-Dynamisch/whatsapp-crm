// ============================================================
// Webinar schedule (migration 097) for journey code steps.
//
// A code step that mentions `webinar` gets `webinar` in its input:
//   { sessions: [{ start_iso: 'YYYY-MM-DDTHH:MM:SS+05:30', link }],
//     rules: { weekday/weekend cutoff/msg2/msg3 minutes, checkin_hour } }
// or null when the account doesn't use the schedule (the journey then
// keeps its built-in daily rule). Upcoming scheduled sessions only.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { accountHasFeature } from '@/lib/features-server';

export interface WebinarRules {
  weekday_cutoff_min: number;
  weekday_msg2_min: number;
  weekday_msg3_min: number;
  weekend_cutoff_min: number;
  weekend_msg2_min: number;
  weekend_msg3_min: number;
  checkin_hour: number;
  default_weekday_time: string;
  default_weekend_time: string;
}

export const DEFAULT_WEBINAR_RULES: WebinarRules = {
  weekday_cutoff_min: 360,
  weekday_msg2_min: 360,
  weekday_msg3_min: 60,
  weekend_cutoff_min: 300,
  weekend_msg2_min: 240,
  weekend_msg3_min: 60,
  checkin_hour: 7,
  default_weekday_time: '20:00',
  default_weekend_time: '15:00',
};

export interface WebinarScope {
  sessions: { start_iso: string; link: string | null }[];
  rules: WebinarRules;
}

const IST_MS = 5.5 * 3600e3;

/** A timestamp as the IST wall-clock ISO the journey uses ("…+05:30"). */
export function toIstIso(ts: string | number | Date): string {
  const ms = typeof ts === 'number' ? ts : new Date(ts).getTime();
  return new Date(ms + IST_MS).toISOString().slice(0, 19) + '+05:30';
}

export async function loadWebinarRules(db: SupabaseClient, accountId: string): Promise<WebinarRules> {
  const { data } = await db.from('webinar_settings').select('*').eq('account_id', accountId).maybeSingle();
  return { ...DEFAULT_WEBINAR_RULES, ...((data ?? {}) as Partial<WebinarRules>) };
}

export async function loadWebinarScope(db: SupabaseClient, accountId: string, now: Date): Promise<WebinarScope | null> {
  try {
    if (!(await accountHasFeature(db, accountId, 'webinar_schedule'))) return null;
    const { data, error } = await db
      .from('webinar_sessions')
      .select('starts_at, link')
      .eq('account_id', accountId)
      .eq('status', 'scheduled')
      .gte('starts_at', new Date(now.getTime() - 864e5).toISOString())
      .lte('starts_at', new Date(now.getTime() + 60 * 864e5).toISOString())
      .order('starts_at', { ascending: true })
      .limit(200);
    if (error) return null; // before migration 097 — built-in rule
    return {
      sessions: (data ?? []).map((r) => ({ start_iso: toIstIso(r.starts_at as string), link: (r.link as string | null) || null })),
      rules: await loadWebinarRules(db, accountId),
    };
  } catch {
    return null;
  }
}
