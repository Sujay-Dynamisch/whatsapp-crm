// ============================================================
// WhatsApp number quality-rating guard (migration 048).
//
// Meta rates every business number GREEN / YELLOW / RED from recent
// blocks and reports. A RED number is close to being restricted, and
// pushing a broadcast through it makes that worse. Before a broadcast
// pass we look at the cached rating (refreshing it from the Graph API
// when it's older than an hour) and decide:
//
//   GREEN / UNKNOWN → allow
//   YELLOW          → slow   (smaller passes, spaced out)
//   RED             → block
//
// Only when the account has 'smart_sending' and quality_guard is on.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { META_API_BASE } from '@/lib/whatsapp/meta-api';
import { accountHasFeature } from '@/lib/features-server';
import { DEFAULT_DELIVERY_SETTINGS, type DeliverySettings } from './settings';

export type QualityRating = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
export type GuardAction = 'allow' | 'slow' | 'block';

export interface QualityGuard {
  action: GuardAction;
  rating: QualityRating;
  tier: string | null;
  settings: DeliverySettings;
}

const STALE_MS = 60 * 60 * 1000;

export function normalizeRating(raw: unknown): QualityRating {
  const r = typeof raw === 'string' ? raw.toUpperCase() : '';
  return r === 'GREEN' || r === 'YELLOW' || r === 'RED' ? r : 'UNKNOWN';
}

export function guardActionFor(rating: QualityRating, guardOn: boolean): GuardAction {
  if (!guardOn) return 'allow';
  return rating === 'RED' ? 'block' : rating === 'YELLOW' ? 'slow' : 'allow';
}

/** Ask Meta for the number's current rating + messaging tier. */
export async function fetchPhoneQuality(
  phoneNumberId: string,
  accessToken: string
): Promise<{ rating: QualityRating; tier: string | null }> {
  const res = await fetch(
    `${META_API_BASE}/${encodeURIComponent(phoneNumberId)}?fields=quality_rating,messaging_limit_tier`,
    { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) }
  );
  const body = (await res.json().catch(() => ({}))) as {
    quality_rating?: string;
    messaging_limit_tier?: string;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(body.error?.message ?? `Graph API ${res.status}`);
  return { rating: normalizeRating(body.quality_rating), tier: body.messaging_limit_tier ?? null };
}

/** Refresh and store the rating for one account's number. */
export async function refreshQuality(
  db: SupabaseClient,
  accountId: string
): Promise<{ rating: QualityRating; tier: string | null } | null> {
  const { data: cfg } = await db
    .from('whatsapp_config')
    .select('id, phone_number_id, access_token')
    .eq('account_id', accountId)
    .maybeSingle();
  if (!cfg?.phone_number_id || !cfg.access_token) return null;

  const q = await fetchPhoneQuality(cfg.phone_number_id, decrypt(cfg.access_token));
  await db
    .from('whatsapp_config')
    .update({
      quality_rating: q.rating,
      messaging_limit_tier: q.tier,
      quality_checked_at: new Date().toISOString(),
    })
    .eq('id', cfg.id);
  return q;
}

export async function loadDeliverySettings(
  db: SupabaseClient,
  accountId: string
): Promise<DeliverySettings> {
  const { data } = await db
    .from('delivery_settings')
    .select('auto_retry_limited, retry_delay_hours, rest_days, rest_after_unread, quality_guard, yellow_pass_size')
    .eq('account_id', accountId)
    .maybeSingle();
  return { ...DEFAULT_DELIVERY_SETTINGS, ...(data ?? {}) };
}

/**
 * Decide whether a broadcast pass may run now. Never throws: a failed
 * lookup or Graph call falls back to the cached rating (or UNKNOWN →
 * allow), so the guard can't take broadcasting down by itself.
 */
export async function checkQualityGuard(
  db: SupabaseClient,
  accountId: string,
  now: Date = new Date()
): Promise<QualityGuard> {
  const allow = (settings = DEFAULT_DELIVERY_SETTINGS): QualityGuard => ({
    action: 'allow',
    rating: 'UNKNOWN',
    tier: null,
    settings,
  });
  try {
    if (!(await accountHasFeature(db, accountId, 'smart_sending'))) return allow();
    const settings = await loadDeliverySettings(db, accountId);

    const { data: cfg } = await db
      .from('whatsapp_config')
      .select('quality_rating, messaging_limit_tier, quality_checked_at')
      .eq('account_id', accountId)
      .maybeSingle();

    let rating = normalizeRating(cfg?.quality_rating);
    let tier = (cfg?.messaging_limit_tier as string | null) ?? null;
    const checkedAt = cfg?.quality_checked_at ? new Date(cfg.quality_checked_at).getTime() : 0;
    if (now.getTime() - checkedAt > STALE_MS) {
      const fresh = await refreshQuality(db, accountId).catch((err) => {
        console.warn('[quality-guard] refresh failed, using cached rating:', err?.message ?? err);
        return null;
      });
      if (fresh) ({ rating, tier } = fresh);
    }
    return { action: guardActionFor(rating, settings.quality_guard), rating, tier, settings };
  } catch (err) {
    console.error('[quality-guard] check failed (allowing):', err);
    return allow();
  }
}
