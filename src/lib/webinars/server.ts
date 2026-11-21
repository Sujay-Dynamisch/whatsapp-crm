// Webinar Schedule (migration 097) — access + time helpers for the API.
// Access: owners/admins, or a custom role granting the 'webinars' area.

import type { SupabaseClient } from '@supabase/supabase-js';

import { ForbiddenError, getCurrentAccount, type AccountContext } from '@/lib/auth/account';
import { atLeast, callersLevel, parseAccess, type AccessLevel } from '@/lib/auth/permissions';
import { supabaseAdmin } from '@/lib/flows/admin-client';

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
