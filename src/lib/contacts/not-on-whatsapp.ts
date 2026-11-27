// ============================================================
// Numbers that are not on WhatsApp.
//
// Meta accepts a message, then reports it failed with 131026 ("message
// undeliverable": no WhatsApp on the number, or a very old app). Such a
// lead kept getting journey messages that always failed. One source of
// truth, used everywhere:
//   * detect:   the 2nd 131026 failure for a contact who never had a
//               message delivered / read and never wrote to us → the
//               'not_on_whatsapp' tag; their live journey runs stop.
//   * respect:  the engine stops any run on that tag (like STOP); the
//               "do not message" list (getUnsubscribedContactIds) skips
//               them in broadcasts / scheduled + manual journey enrolls.
//               Callers can still phone them — callbacks are untouched.
//   * undo:     any message FROM that number (proof it is on WhatsApp),
//               or a corrected number (Callbacks → "Not on WhatsApp" tab),
//               removes the tag.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export const NOT_ON_WHATSAPP_TAG = 'not_on_whatsapp';
/** Meta: message undeliverable (not a WhatsApp number / outdated app). */
export const UNDELIVERABLE_CODE = 131026;
/** Failures before we decide (one odd failure is not enough). */
export const UNDELIVERABLE_THRESHOLD = 2;
export const NOT_ON_WHATSAPP_REASON = 'Number not on WhatsApp';

async function tagId(db: SupabaseClient, accountId: string, create: boolean): Promise<string | null> {
  const { data } = await db.from('tags').select('id').eq('account_id', accountId).ilike('name', NOT_ON_WHATSAPP_TAG).maybeSingle();
  if (data?.id || !create) return (data?.id as string | undefined) ?? null;
  const { data: acct } = await db.from('accounts').select('owner_user_id').eq('id', accountId).maybeSingle();
  const { data: made } = await db
    .from('tags')
    .insert({ account_id: accountId, user_id: acct?.owner_user_id ?? null, name: NOT_ON_WHATSAPP_TAG, color: '#64748b' })
    .select('id')
    .single();
  return (made?.id as string | undefined) ?? null;
}

/** Has this contact ever been reached on WhatsApp (delivered / read, or wrote to us)? */
async function everReached(db: SupabaseClient, contactId: string): Promise<boolean> {
  const { count: delivered } = await db
    .from('journey_messages')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
    .in('status', ['delivered', 'read']);
  if ((delivered ?? 0) > 0) return true;
  const { data: convs } = await db.from('conversations').select('id').eq('contact_id', contactId);
  const ids = (convs ?? []).map((c) => c.id as string);
  if (!ids.length) return false;
  const { count: inbound } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .in('conversation_id', ids)
    .eq('sender_type', 'customer');
  return (inbound ?? 0) > 0;
}

/**
 * After a 131026 failure: tag the contact and stop their live journey runs
 * once the threshold is reached. Returns true when the contact was tagged.
 * Never throws.
 */
export async function markIfNotOnWhatsApp(db: SupabaseClient, accountId: string, contactId: string, now = new Date()): Promise<boolean> {
  try {
    const { count } = await db
      .from('journey_messages')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', contactId)
      .eq('status', 'failed')
      .eq('error_code', UNDELIVERABLE_CODE);
    if ((count ?? 0) < UNDELIVERABLE_THRESHOLD) return false;
    if (await everReached(db, contactId)) return false;
    const id = await tagId(db, accountId, true);
    if (!id) return false;
    await db.from('contact_tags').upsert({ contact_id: contactId, tag_id: id }, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true });
    await stopLiveRuns(db, contactId, now);
    // Their failures move off the Failed messages list (and its counts): the
    // fix is a phone call, done in Callbacks → "Not on WhatsApp".
    await db
      .from('journey_messages')
      .update({ resolved: 'dismissed', resolved_at: now.toISOString() })
      .eq('contact_id', contactId)
      .eq('status', 'failed')
      .eq('error_code', UNDELIVERABLE_CODE)
      .is('resolved', null);
    return true;
  } catch (err) {
    console.warn('[not-on-whatsapp] mark failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Stop the contact's waiting runs now (the engine also stops any run on the tag at its next step). */
export async function stopLiveRuns(db: SupabaseClient, contactId: string, now = new Date()): Promise<number> {
  const { data } = await db
    .from('journey_enrollments')
    .update({ status: 'exited', wait_kind: null, locked_at: null, next_run_at: null, last_error: NOT_ON_WHATSAPP_REASON, completed_at: now.toISOString() })
    .eq('contact_id', contactId)
    .eq('status', 'waiting')
    .select('id');
  return data?.length ?? 0;
}

/** The number wrote to us / was corrected: it is reachable again. Never throws. */
export async function clearNotOnWhatsApp(db: SupabaseClient, accountId: string, contactId: string): Promise<void> {
  try {
    const id = await tagId(db, accountId, false);
    if (id) await db.from('contact_tags').delete().eq('contact_id', contactId).eq('tag_id', id);
  } catch {
    // best effort
  }
}
