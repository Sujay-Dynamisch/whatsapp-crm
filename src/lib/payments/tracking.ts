// ============================================================
// Payments module helpers (migrations 063/064). The module is the
// off-by-default 'payments' feature (admin → Features); its settings row
// (payment_tracking) is created on first use and names three tags:
// pending (payment link sent), paid (a journey exit tag) and closed
// (not proceeding).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { stopEnrollment } from '@/lib/journeys/engine';
import { findTrigger, type JourneyGraph, type TriggerConfig } from '@/lib/journeys/graph';

export interface PaymentTracking {
  account_id: string;
  pending_tag: string;
  paid_tag: string;
  closed_tag: string;
  currency: string;
}

/** The account's settings row, created with defaults the first time. */
export async function loadTracking(db: SupabaseClient, accountId: string): Promise<PaymentTracking | null> {
  const cols = 'account_id, pending_tag, paid_tag, closed_tag, currency';
  const { data } = await db.from('payment_tracking').select(cols).eq('account_id', accountId).maybeSingle();
  if (data) return data as PaymentTracking;
  // Callers already passed the feature + permission gates (middleware).
  const { data: made } = await supabaseAdmin()
    .from('payment_tracking')
    .upsert({ account_id: accountId }, { onConflict: 'account_id' })
    .select(cols)
    .maybeSingle();
  return (made as PaymentTracking | null) ?? null;
}

/** Tag ids by lower-cased name for the given names (missing ones absent). */
export async function tagIdsByName(db: SupabaseClient, accountId: string, names: string[]): Promise<Map<string, string>> {
  const { data } = await db.from('tags').select('id, name').eq('account_id', accountId);
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const out = new Map<string, string>();
  for (const t of (data ?? []) as { id: string; name: string }[]) {
    const key = t.name.trim().toLowerCase();
    if (wanted.has(key) && !out.has(key)) out.set(key, t.id);
  }
  return out;
}

/** The account's tag called `name`, created when missing. */
export async function ensureTag(db: SupabaseClient, accountId: string, userId: string, name: string): Promise<string> {
  const existing = (await tagIdsByName(db, accountId, [name])).get(name.toLowerCase());
  if (existing) return existing;
  const { data, error } = await db
    .from('tags')
    .insert({ account_id: accountId, user_id: userId, name, color: '#10b981' })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('Could not create tag');
  return data.id as string;
}

/**
 * Stop the contact's waiting journey runs whose exit tags include
 * `tagId` right away (the engine would stop them at their next wake-up
 * anyway), so run history shows it immediately.
 */
export async function stopRunsExitingOnTag(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; tagId: string; reason: string; now: Date }
): Promise<number> {
  const { data: runs } = await db
    .from('journey_enrollments')
    .select('id, journey_id, journeys(graph)')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .eq('status', 'waiting');
  let stopped = 0;
  for (const r of (runs ?? []) as { id: string; journey_id: string; journeys?: unknown }[]) {
    const j = (Array.isArray(r.journeys) ? r.journeys[0] : r.journeys) as { graph?: JourneyGraph } | null;
    const exitIds = j?.graph ? ((findTrigger(j.graph)?.config as TriggerConfig | undefined)?.exit_tag_ids ?? []) : [];
    if (!exitIds.includes(args.tagId)) continue;
    const outcome = await stopEnrollment(db, {
      enrollmentId: r.id,
      journeyId: r.journey_id,
      accountId: args.accountId,
      reason: args.reason,
      now: args.now,
    });
    if (outcome === 'stopped') stopped++;
  }
  return stopped;
}
