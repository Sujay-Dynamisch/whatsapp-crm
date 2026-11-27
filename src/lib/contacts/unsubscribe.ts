import type { SupabaseClient } from '@supabase/supabase-js';
import type { Contact, Tag } from '@/types';
import { addContactTagIfAbsent, removeContactTag } from './tag-write';
import { NOT_ON_WHATSAPP_TAG } from './not-on-whatsapp';

export const UNSUBSCRIBE_TAG_NAME = 'unsubscribe';

const UNSUBSCRIBE_PATTERNS = [
  /^\s*(stop|unsubscribe|optout|opt-out|cancel)\b/i,
  /^\s*(stop|unsubscribe)\s+(messaging|messages|whatsapp|sending|me)\b/i,
  /^\s*(please|pls)\s+stop\b/i,
  /^\s*don'?t\s+send\s+(me\s+)?messages?\b/i,
  /^\s*no\s+more\s+messages?\b/i,
];

/**
 * Check whether an inbound text message represents an opt-out / stop request.
 */
export function isUnsubscribeText(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  return UNSUBSCRIBE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Check if a contact object carries the 'unsubscribe' tag.
 */
export function isContactUnsubscribed(contact: Partial<Contact> | null | undefined): boolean {
  if (!contact || !Array.isArray(contact.tags)) return false;
  return contact.tags.some(
    (t) => t && typeof t.name === 'string' && t.name.trim().toLowerCase() === UNSUBSCRIBE_TAG_NAME
  );
}

/**
 * Get or create the 'unsubscribe' tag for an account.
 */
export async function ensureUnsubscribeTag(
  db: SupabaseClient,
  accountId: string,
  userId?: string
): Promise<Tag | null> {
  const { data: existing, error: fetchErr } = await db
    .from('tags')
    .select('*')
    .eq('account_id', accountId)
    .ilike('name', UNSUBSCRIBE_TAG_NAME)
    .maybeSingle();

  if (!fetchErr && existing) {
    return existing as Tag;
  }

  // Create tag if it doesn't exist
  const insertData: Record<string, unknown> = {
    account_id: accountId,
    name: UNSUBSCRIBE_TAG_NAME,
    color: '#ef4444', // red badge color
  };
  if (userId) insertData.user_id = userId;

  const { data: created, error: createErr } = await db
    .from('tags')
    .insert(insertData)
    .select()
    .single();

  if (createErr) {
    console.error('[unsubscribe] Failed to create unsubscribe tag:', createErr);
    // If lost a race, try fetching once more
    const { data: raced } = await db
      .from('tags')
      .select('*')
      .eq('account_id', accountId)
      .ilike('name', UNSUBSCRIBE_TAG_NAME)
      .maybeSingle();
    return (raced as Tag) ?? null;
  }

  return created as Tag;
}

/**
 * Tag a contact as unsubscribed.
 */
export async function tagContactAsUnsubscribed(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  userId?: string
): Promise<boolean> {
  const tag = await ensureUnsubscribeTag(db, accountId, userId);
  if (!tag) return false;

  return await addContactTagIfAbsent(db, {
    accountId,
    contactId,
    tagId: tag.id,
  });
}

/**
 * Remove the unsubscribe tag from a contact (resubscribe).
 */
export async function removeUnsubscribeTag(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<void> {
  const { data: tag } = await db
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .ilike('name', UNSUBSCRIBE_TAG_NAME)
    .maybeSingle();

  if (!tag) return;

  await removeContactTag(db, {
    accountId,
    contactId,
    tagId: tag.id,
  });
}

/**
 * Fetch a set of contact_ids for contacts in the given account who have the unsubscribe tag.
 */
export async function getUnsubscribedContactIds(
  db: SupabaseClient,
  accountId: string
): Promise<Set<string>> {
  // Also numbers that are not on WhatsApp (not-on-whatsapp.ts): a message
  // to them can never arrive, so every bulk sender skips them too.
  const { data: tags } = await db
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .or(`name.ilike.${UNSUBSCRIBE_TAG_NAME},name.ilike.${NOT_ON_WHATSAPP_TAG}`);

  if (!tags?.length) return new Set();

  const out = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data: rows } = await db
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', tags.map((t) => t.id))
      .order('contact_id')
      .range(from, from + 999);
    for (const r of rows ?? []) out.add(r.contact_id);
    if (!rows || rows.length < 1000) break;
  }
  return out;
}
