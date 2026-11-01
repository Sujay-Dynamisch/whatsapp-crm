// ============================================================
// Health alerts (feature 'failed_messages', migration 060).
//
//   * heartbeat     — journeyTick stamps system_heartbeats every run; the
//                     app warns admins when it hasn't run for 10 minutes
//                     (a stopped scheduler can't raise its own alarm).
//   * lead feed     — the website lead sync notifies owners/admins when
//                     a source starts failing and when it recovers.
//   * daily summary — once a day after 9 AM IST, owners/admins get
//                     yesterday's numbers: failed messages (and how many
//                     were fixed), skipped registrations, lead feed state.
// Only accounts with the feature on are notified. Never throws.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isFeatureEnabled } from '@/lib/features';
import { accountHasFeature } from '@/lib/features-server';
import { listFailed } from '@/lib/failed-messages/service';

export const TICK_HEARTBEAT = 'journey_tick';
/** No tick for this long = the scheduler is down. */
export const STALE_TICK_MS = 10 * 60_000;
/** Daily summary from this IST hour. */
export const SUMMARY_HOUR_IST = 9;
const IST_MS = 5.5 * 3600_000;
const DAY_MS = 864e5;

export async function recordHeartbeat(db: SupabaseClient, name: string, report: unknown, now = new Date()): Promise<void> {
  try {
    await db.from('system_heartbeats').upsert({ name, last_at: now.toISOString(), report: report ?? null }, { onConflict: 'name' });
  } catch {
    // best effort
  }
}

export type HealthNotificationType = 'health_alert' | 'health_summary';

/** Notify an account's owners and admins. */
export async function notifyAccountAdmins(
  db: SupabaseClient,
  accountId: string,
  type: HealthNotificationType,
  title: string,
  body: string
): Promise<number> {
  const { data } = await db.from('profiles').select('user_id, account_role').eq('account_id', accountId);
  const rows = ((data ?? []) as { user_id: string; account_role?: string }[])
    .filter((p) => p.account_role === 'owner' || p.account_role === 'admin')
    .map((p) => ({ account_id: accountId, user_id: p.user_id, type, title, body }));
  if (rows.length) await db.from('notifications').insert(rows);
  return rows.length;
}

/** Lead sync: a source just started failing or recovered → tell admins (feature on only). */
export async function leadFeedChanged(
  db: SupabaseClient,
  accountId: string,
  previousError: string | null,
  currentError: string | null
): Promise<void> {
  try {
    if (Boolean(previousError) === Boolean(currentError)) return;
    if (!(await accountHasFeature(db, accountId, 'failed_messages'))) return;
    if (currentError) {
      await notifyAccountAdmins(db, accountId, 'health_alert', 'Website lead feed is failing — new registrations are not coming in', currentError.slice(0, 300));
    } else {
      await notifyAccountAdmins(db, accountId, 'health_alert', 'Website lead feed is working again', 'New registrations are being imported again.');
    }
  } catch (err) {
    console.error('[health] lead feed alert failed:', err instanceof Error ? err.message : err);
  }
}

/** Yesterday (IST) as [from, to) ISO plus its YYYY-MM-DD label. */
export function istYesterday(now: Date): { day: string; from: string; to: string } {
  const todayStartIst = Math.floor((now.getTime() + IST_MS) / DAY_MS) * DAY_MS; // IST midnight as plain ms
  const from = todayStartIst - DAY_MS - IST_MS;
  return {
    day: new Date(todayStartIst - DAY_MS).toISOString().slice(0, 10),
    from: new Date(from).toISOString(),
    to: new Date(from + DAY_MS).toISOString(),
  };
}

export interface DailySummary {
  day: string;
  failed: number;
  fixed: number;
  still_open: number;
  skipped_registrations: number;
  lead_feed: 'ok' | 'failing' | 'off';
  lead_feed_error: string | null;
}

export function summaryText(s: DailySummary): { title: string; body: string } {
  const parts = [
    s.failed === 0 ? 'No failed messages' : `${s.failed} message${s.failed === 1 ? '' : 's'} failed (${s.fixed} fixed, ${s.still_open} still open)`,
    s.skipped_registrations === 0 ? 'no skipped registrations' : `${s.skipped_registrations} registration${s.skipped_registrations === 1 ? '' : 's'} skipped (invalid phone)`,
    s.lead_feed === 'off' ? null : s.lead_feed === 'ok' ? 'lead feed OK' : `lead feed FAILING: ${s.lead_feed_error ?? ''}`.trim(),
  ].filter(Boolean);
  const label = new Date(`${s.day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const bad = s.still_open > 0 || s.skipped_registrations > 0 || s.lead_feed === 'failing';
  return { title: `${bad ? '⚠ ' : '✓ '}Daily health — ${label}`, body: parts.join(' · ') };
}

export async function buildSummary(db: SupabaseClient, accountId: string, now: Date): Promise<DailySummary> {
  const y = istYesterday(now);
  const failed = await listFailed(db, accountId, { from: y.from, to: y.to, status: 'all', now });
  const { count: skipped } = await db
    .from('lead_sync_issues')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .gte('created_at', y.from)
    .lt('created_at', y.to);
  const { data: sources } = await db.from('lead_sync_sources').select('enabled, last_report').eq('account_id', accountId);
  const live = ((sources ?? []) as { enabled: boolean; last_report: { error?: string } | null }[]).filter((s) => s.enabled);
  const err = live.map((s) => s.last_report?.error).find(Boolean) ?? null;
  return {
    day: y.day,
    failed: failed.stats.failed,
    fixed: failed.stats.resolved,
    still_open: failed.stats.open,
    skipped_registrations: skipped ?? 0,
    lead_feed: live.length === 0 ? 'off' : err ? 'failing' : 'ok',
    lead_feed_error: err,
  };
}

/** journeyTick: after 9 AM IST, each account with the feature gets yesterday's summary once. */
export async function runDailySummaries(db: SupabaseClient, now = new Date()): Promise<{ sent: number; errors: string[] }> {
  const out = { sent: 0, errors: [] as string[] };
  const istHour = new Date(now.getTime() + IST_MS).getUTCHours();
  if (istHour < SUMMARY_HOUR_IST) return out;
  const { day } = istYesterday(now);
  const { data: accounts } = await db.from('accounts').select('id, disabled_features');
  for (const a of (accounts ?? []) as { id: string; disabled_features: string[] | null }[]) {
    if (!isFeatureEnabled(a.disabled_features, 'failed_messages')) continue;
    try {
      // Claim the day first so a parallel tick can't send it twice.
      const { error } = await db.from('health_summaries').insert({ account_id: a.id, day, sent_at: now.toISOString() });
      if (error) continue; // already sent (or claimed) today
      const summary = await buildSummary(db, a.id, now);
      await db.from('health_summaries').update({ summary }).eq('account_id', a.id).eq('day', day);
      const { title, body } = summaryText(summary);
      if (await notifyAccountAdmins(db, a.id, 'health_summary', title, body)) out.sent++;
    } catch (err) {
      out.errors.push(`${a.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
