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
