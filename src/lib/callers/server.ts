// ============================================================
// Caller management (migration 086) — server helpers.
//
// Access: owners/admins, or a custom role granting the 'callers' area
// (callersLevel). Writes go through the service role after that check,
// always scoped to the caller's own account.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { ForbiddenError, getCurrentAccount, type AccountContext } from '@/lib/auth/account';
import { atLeast, callersLevel, parseAccess, type AccessLevel } from '@/lib/auth/permissions';
import { supabaseAdmin } from '@/lib/flows/admin-client';

export async function requireCallersAccess(level: AccessLevel): Promise<AccountContext & { admin: SupabaseClient }> {
  const ctx = await getCurrentAccount();
  const { data } = await ctx.supabase.rpc('my_permissions');
  if (!atLeast(callersLevel(parseAccess(data), ctx.role), level)) throw new ForbiddenError();
  return { ...ctx, admin: supabaseAdmin() };
}

/** Is `userId` an active member of `accountId`? */
export async function isAccountMember(db: SupabaseClient, accountId: string, userId: string): Promise<boolean> {
  const { data } = await db.from('profiles').select('user_id').eq('account_id', accountId).eq('user_id', userId).maybeSingle();
  return !!data;
}

/**
 * Give a customer (and their open engagement + open callbacks) to
 * `toCallerId` (null = Admin Unassigned). Audited; the new owner is
 * notified. Never touches the round-robin cursor.
 */
export async function reassignContact(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; toCallerId: string | null; actorId: string | null; reason: string; notify?: boolean }
): Promise<void> {
  const { data: contact } = await db
    .from('contacts')
    .select('id, name, phone, assigned_caller_id')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (!contact) throw new ForbiddenError('Contact not found');
  const from = (contact.assigned_caller_id as string | null) ?? null;
  if (from === args.toCallerId) return;

  const { data: eng } = await db
    .from('engagements')
    .select('id')
    .eq('contact_id', args.contactId)
    .eq('status', 'open')
    .order('accepted_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  await db.from('contacts').update({ assigned_caller_id: args.toCallerId }).eq('id', args.contactId);
  if (eng) await db.from('engagements').update({ assigned_caller_id: args.toCallerId }).eq('id', eng.id);
  await db
    .from('callback_requests')
    .update({ assigned_caller_id: args.toCallerId, updated_at: new Date().toISOString() })
    .eq('contact_id', args.contactId)
    .neq('status', 'done');
  await db.from('caller_assignment_history').insert({
    account_id: args.accountId,
    contact_id: args.contactId,
    engagement_id: eng?.id ?? null,
    from_caller_id: from,
    to_caller_id: args.toCallerId,
    actor_id: args.actorId,
    reason: args.reason,
  });

  if (args.toCallerId && args.notify !== false) {
    const label = (contact.name as string | null) || (contact.phone as string);
    await db.from('notifications').insert({
      account_id: args.accountId,
      user_id: args.toCallerId,
      type: 'callback_assigned',
      contact_id: args.contactId,
      title: 'Lead assigned to you',
      body: label,
    });
  }
}

/** Move all of a caller's open work to Admin Unassigned (deactivation / removal). */
export async function releaseCallerWork(db: SupabaseClient, accountId: string, callerId: string, actorId: string): Promise<number> {
  const { data: owned } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .eq('assigned_caller_id', callerId)
    .limit(5000);
  for (const c of owned ?? []) {
    await reassignContact(db, {
      accountId,
      contactId: c.id as string,
      toCallerId: null,
      actorId,
      reason: 'CALLER_DEACTIVATED',
      notify: false,
    });
  }
  // Callbacks still pointing at the caller without an owned contact.
  await db
    .from('callback_requests')
    .update({ assigned_caller_id: null })
    .eq('account_id', accountId)
    .eq('assigned_caller_id', callerId)
    .neq('status', 'done');
  return owned?.length ?? 0;
}

/**
 * Leads a person took away from a caller without giving them to anyone
 * (manual "Unassigned", deactivation, member removed) and that still have
 * no owner — they belong in Admin Unassigned even when they have no open
 * engagement or callback. contactId → when they were released.
 */
export async function releasedContacts(db: SupabaseClient, accountId: string): Promise<Map<string, string>> {
  const { data: rows } = await db
    .from('caller_assignment_history')
    .select('contact_id, to_caller_id, created_at')
    .eq('account_id', accountId)
    .gte('created_at', new Date(Date.now() - 90 * 864e5).toISOString())
    .order('created_at', { ascending: false })
    .limit(5000);
  const latest = new Map<string, { to: string | null; at: string }>();
  for (const r of rows ?? []) {
    const id = r.contact_id as string | null;
    if (id && !latest.has(id)) latest.set(id, { to: (r.to_caller_id as string | null) ?? null, at: r.created_at as string });
  }
  const candidates = [...latest].filter(([, v]) => v.to === null).map(([id]) => id);
  const out = new Map<string, string>();
  for (let i = 0; i < candidates.length; i += 500) {
    const { data } = await db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .is('assigned_caller_id', null)
      .in('id', candidates.slice(i, i + 500));
    for (const c of data ?? []) out.set(c.id as string, latest.get(c.id as string)!.at);
  }
  return out;
}
