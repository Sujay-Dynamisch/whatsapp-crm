// Webinar Schedule (migration 097) — access + time helpers for the API.
// Access: owners/admins, or a custom role granting the 'webinars' area.

import type { SupabaseClient } from '@supabase/supabase-js';

import { ForbiddenError, getCurrentAccount, type AccountContext } from '@/lib/auth/account';
import { atLeast, callersLevel, parseAccess, type AccessLevel } from '@/lib/auth/permissions';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { toIstIso } from '@/lib/journeys/webinar';

export async function requireWebinarAccess(level: AccessLevel): Promise<AccountContext & { admin: SupabaseClient }> {
  const ctx = await getCurrentAccount();
  const { data } = await ctx.supabase.rpc('my_permissions');
  if (!atLeast(callersLevel(parseAccess(data), ctx.role, 'webinars'), level)) throw new ForbiddenError();
  return { ...ctx, admin: supabaseAdmin() };
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "2026-11-24" + "20:00" (IST wall clock) → UTC ISO, or null if invalid. */
export function istToUtc(date: string, time: string): string | null {
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) return null;
  const ms = Date.parse(`${date}T${time}:00+05:30`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function isWeekendDate(date: string): boolean {
  const d = new Date(`${date}T12:00:00+05:30`).getUTCDay();
  return d === 0 || d === 6;
}

export interface Readiness {
  /** Cancels / time changes can safely move booked leads. */
  ready: boolean;
  /** Blocking — what must be fixed first. */
  problems: string[];
  /** Not blocking, but the admin should know. */
  warnings: string[];
}

const REQUIRED_ENGINE = 3;

/**
 * Is the system really following the Webinar Schedule? Checks the live
 * journey (rebuilt with the schedule-aware steps), the minute job (new
 * engine, running) and the "session changed" template.
 */
export async function webinarReadiness(db: SupabaseClient, accountId: string): Promise<Readiness> {
  const problems: string[] = [];
  const warnings: string[] = [];

  const { data: journeys } = await db.from('journeys').select('graph').eq('account_id', accountId).eq('status', 'active');
  const aware = (journeys ?? []).some((j) => {
    const nodes = ((j.graph as { nodes?: { type: string; config?: Record<string, unknown> }[] } | null)?.nodes ?? []);
    const trigger = nodes.find((n) => n.type === 'trigger');
    return !!trigger?.config?.session_moved_node && nodes.some((n) => n.type === 'code' && String(n.config?.code ?? '').includes('$input.webinar'));
  });
  if (!aware) problems.push('The webinar journey is not updated to follow this schedule yet — it still uses the built-in daily times. (Rebuild the journey.)');

  const { data: hb } = await db.from('system_heartbeats').select('last_at, report').eq('name', 'journey_tick').maybeSingle();
  const lastAt = Date.parse(String(hb?.last_at ?? ''));
  const engine = Number((hb?.report as { engine?: number } | null)?.engine ?? 0);
  if (!Number.isFinite(lastAt) || Date.now() - lastAt > 10 * 60_000) {
    problems.push('The background job that sends journey messages has not run in the last 10 minutes.');
  } else if (engine < REQUIRED_ENGINE) {
    problems.push('The background job is on an older version that ignores this schedule. (Redeploy journeyTick.)');
  }

  const { data: tpl } = await db
    .from('message_templates')
    .select('status')
    .eq('account_id', accountId)
    .eq('name', 'sg_webinar_session_changed')
    .maybeSingle();
  if (String(tpl?.status ?? '').toUpperCase() !== 'APPROVED') {
    warnings.push('The "session changed" WhatsApp template is not approved yet — moved leads will get their new reminders but not the change message.');
  }
  return { ready: problems.length === 0, problems, warnings };
}

/** The first scheduled session after `afterMs` (and not `excludeId`), at least 30 min ahead. */
export async function nextScheduledSession(
  db: SupabaseClient,
  accountId: string,
  excludeId: string | null
): Promise<{ id: string; starts_at: string } | null> {
  let q = db
    .from('webinar_sessions')
    .select('id, starts_at')
    .eq('account_id', accountId)
    .eq('status', 'scheduled')
    .gte('starts_at', new Date(Date.now() + 30 * 60_000).toISOString())
    .order('starts_at', { ascending: true })
    .limit(1);
  if (excludeId) q = q.neq('id', excludeId);
  const { data } = await q;
  return (data?.[0] as { id: string; starts_at: string } | undefined) ?? null;
}

export async function logWebinarChange(
  db: SupabaseClient,
  row: { accountId: string; sessionId: string | null; action: string; detail: string; affected: number; actorId: string }
): Promise<void> {
  await db
    .from('webinar_changes')
    .insert({ account_id: row.accountId, session_id: row.sessionId, action: row.action, detail: row.detail, affected: row.affected, actor_id: row.actorId })
    .then(
      () => undefined,
      () => undefined
    );
}

/** "Mon, 23 Nov, 8:00 PM" from a UTC timestamp. */
export function sessionLabel(startsAt: string): string {
  return new Date(startsAt).toLocaleString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * Where an admin's change sends the session's booked leads — shared by the
 * preview (POST) and the change (PATCH) so what the confirmation says is
 * what the move job does (engine moveBookedRuns → journey schedule step).
 *   'same'  re-time only: this session at its new time (default for a re-time)
 *   'next'  the next scheduled session on a later day (default for a cancel)
 *   <uuid>  that exact upcoming session
 * `target` is what the move job stores (migration 107): null = this session
 * at the new time, 'next', or the chosen session's IST ISO start.
 */
export async function resolveMoveTarget(
  db: SupabaseClient,
  accountId: string,
  session: { id: string; starts_at: string },
  action: 'cancel' | 'time',
  moveTo: unknown,
  newStartUtc: string | null
): Promise<{ target: string | null; goesTo: string | null; error: string | null }> {
  const choice = typeof moveTo === 'string' && moveTo ? moveTo : action === 'time' ? 'same' : 'next';
  const soonest = Date.now() + 30 * 60_000;
  if (choice === 'same') {
    if (action !== 'time' || !newStartUtc) return { target: null, goesTo: null, error: 'Pick where to move the booked leads.' };
    return { target: null, goesTo: sessionLabel(newStartUtc), error: null };
  }
  if (choice === 'next') {
    // A later day than the one they were booked for (IST).
    const IST = 5.5 * 3600e3;
    const dayAfter = Math.floor((Date.parse(session.starts_at) + IST) / 864e5) * 864e5 + 864e5 - IST;
    const { data } = await db
      .from('webinar_sessions')
      .select('id, starts_at')
      .eq('account_id', accountId)
      .eq('status', 'scheduled')
      .neq('id', session.id)
      .gte('starts_at', new Date(Math.max(dayAfter, soonest)).toISOString())
      .order('starts_at', { ascending: true })
      .limit(1);
    const next = data?.[0] as { starts_at: string } | undefined;
    if (!next) return { target: null, goesTo: null, error: 'There is no later session scheduled. Add the next session first.' };
    return { target: 'next', goesTo: sessionLabel(next.starts_at), error: null };
  }
  const { data: picked } = await db
    .from('webinar_sessions')
    .select('id, starts_at, status')
    .eq('id', choice)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!picked || picked.status !== 'scheduled' || picked.id === session.id || Date.parse(picked.starts_at as string) < soonest) {
    return { target: null, goesTo: null, error: 'Pick a scheduled session at least 30 minutes from now.' };
  }
  return { target: toIstIso(picked.starts_at as string), goesTo: sessionLabel(picked.starts_at as string), error: null };
}
