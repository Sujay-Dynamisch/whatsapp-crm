// ============================================================
// Trash (migration 100): admin-only delete with restore.
//
// Deleting a callback request or a payment entry copies it (and, for a
// callback, its timeline) into trash_items and then removes it. An admin
// can restore it exactly as it was (same id) or delete it forever.
// All functions use the service-role client; callers must have checked
// the admin role first.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { reconcileLedger } from '@/lib/payments/ledger';
import { loadTracking } from '@/lib/payments/tracking';

export type TrashKind = 'callback' | 'payment';

export class TrashError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

async function contactLabel(db: SupabaseClient, contactId: string | null): Promise<string> {
  if (!contactId) return 'Unknown';
  const { data } = await db.from('contacts').select('name, phone').eq('id', contactId).maybeSingle();
  return [data?.name, data?.phone].filter(Boolean).join(' · ') || 'Unknown';
}

async function callbackTagId(db: SupabaseClient, accountId: string): Promise<string | null> {
  const { data } = await db.from('tags').select('id').eq('account_id', accountId).ilike('name', 'callback_requested').limit(1).maybeSingle();
  return (data?.id as string) ?? null;
}

export async function trashCallback(db: SupabaseClient, args: { accountId: string; userId: string; id: string }) {
  const { data: row } = await db.from('callback_requests').select('*').eq('id', args.id).eq('account_id', args.accountId).maybeSingle();
  if (!row) throw new TrashError('Request not found', 404);
  const { data: events } = await db.from('callback_events').select('*').eq('callback_id', args.id);
  const contactId = row.contact_id as string;

  const { error: tErr } = await db.from('trash_items').insert({
    account_id: args.accountId,
    kind: 'callback',
    record_id: args.id,
    contact_id: contactId,
    label: `Callback request — ${await contactLabel(db, contactId)}`,
    payload: { row, events: events ?? [] },
    deleted_by: args.userId,
  });
  if (tErr) throw new Error(tErr.message);
  const { error } = await db.from('callback_requests').delete().eq('id', args.id).eq('account_id', args.accountId);
  if (error) throw new Error(error.message);

  // An open request carried the callback_requested tag — remove it so a
  // new tap by the lead opens a fresh request.
  if (row.status !== 'done') {
    const tagId = await callbackTagId(db, args.accountId);
    if (tagId) await db.from('contact_tags').delete().eq('contact_id', contactId).eq('tag_id', tagId);
  }
}

export async function trashPayment(db: SupabaseClient, args: { accountId: string; userId: string; contactId: string; id: string }) {
  const { data: row } = await db
    .from('payment_installments')
    .select('*')
    .eq('id', args.id)
    .eq('contact_id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (!row) throw new TrashError('Payment not found', 404);
  const amount = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(Number(row.amount));
  const { error: tErr } = await db.from('trash_items').insert({
    account_id: args.accountId,
    kind: 'payment',
    record_id: args.id,
    contact_id: args.contactId,
    label: `${amount} payment (${row.paid_on}) — ${await contactLabel(db, args.contactId)}`,
    payload: { row },
    deleted_by: args.userId,
  });
  if (tErr) throw new Error(tErr.message);
  const { error } = await db.from('payment_installments').delete().eq('id', args.id).eq('account_id', args.accountId);
  if (error) throw new Error(error.message);
}

export async function listTrash(db: SupabaseClient, accountId: string, kind: TrashKind) {
  const { data, error } = await db
    .from('trash_items')
    .select('id, kind, record_id, contact_id, label, deleted_by, deleted_at')
    .eq('account_id', accountId)
    .eq('kind', kind)
    .is('restored_at', null)
    .order('deleted_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  const ids = [...new Set((data ?? []).map((d) => d.deleted_by as string).filter(Boolean))];
  const { data: people } = ids.length ? await db.from('profiles').select('user_id, full_name').in('user_id', ids) : { data: [] };
  const nameOf = new Map((people ?? []).map((p) => [p.user_id as string, (p.full_name as string) || 'Team member']));
  return (data ?? []).map((d) => ({ ...d, deleted_by_name: nameOf.get(d.deleted_by as string) ?? null }));
}

async function loadItem(db: SupabaseClient, accountId: string, trashId: string) {
  const { data } = await db.from('trash_items').select('*').eq('id', trashId).eq('account_id', accountId).is('restored_at', null).maybeSingle();
  if (!data) throw new TrashError('This item is no longer in the trash', 404);
  return data;
}

export async function restoreTrash(db: SupabaseClient, args: { accountId: string; userId: string; trashId: string; who: string }) {
  const item = await loadItem(db, args.accountId, args.trashId);
  const payload = item.payload as { row: Record<string, unknown>; events?: Record<string, unknown>[] };
  const table = item.kind === 'callback' ? 'callback_requests' : 'payment_installments';

  const { error } = await db.from(table).insert(payload.row);
  if (error) {
    if (error.code === '23505' && item.kind === 'callback') {
      throw new TrashError('This lead already has an open callback request. Mark it Done first, then restore.', 409);
    }
    if (error.code === '23505') throw new TrashError('This entry already exists.', 409);
    if (error.code === '23503') throw new TrashError('The contact for this entry was deleted, so it cannot be restored.', 409);
    throw new Error(error.message);
  }

  if (item.kind === 'callback') {
    if (payload.events?.length) {
      const { error: eErr } = await db.from('callback_events').insert(payload.events);
      if (eErr) console.error('[trash] timeline restore failed:', eErr.message);
    }
  } else {
    // The lead's paid / balance state follows the restored payment.
    const tracking = await loadTracking(db, args.accountId);
    if (tracking) {
      await reconcileLedger(db, { accountId: args.accountId, contactId: payload.row.contact_id as string, userId: args.userId, who: args.who, tracking }).catch(
        (e) => console.error('[trash] ledger reconcile failed:', e instanceof Error ? e.message : e)
      );
    }
  }

  await db.from('trash_items').update({ restored_at: new Date().toISOString(), restored_by: args.userId }).eq('id', args.trashId);
  return { kind: item.kind as TrashKind };
}

export async function purgeTrash(db: SupabaseClient, args: { accountId: string; trashId: string }) {
  await loadItem(db, args.accountId, args.trashId);
  const { error } = await db.from('trash_items').delete().eq('id', args.trashId).eq('account_id', args.accountId);
  if (error) throw new Error(error.message);
}
