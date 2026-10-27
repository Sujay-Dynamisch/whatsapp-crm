// ============================================================
// Pulls new webinar registrations from an external admin API into
// one account's contacts, then starts that account's "contact created"
// journeys (source 'api') — the same path as POST /api/v1/contacts.
//
// Runs inside the every-minute journeyTick function, so it needs no
// extra scheduler job. Stateless: each run re-reads the last
// LOOKBACK_MINUTES of registrations and relies on the phone dedupe in
// findOrCreateContact, so a missed tick is covered by the next one and
// older registrations are never back-filled.
//
// Configured per account in `lead_sync_sources` (migration 057); only
// rows with enabled = true run — toggled from Settings → API.
// LEAD_SYNC_SOURCE_TOKEN (optional env) is sent as "Authorization: Bearer …".
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  findOrCreateContact,
  resolveAuditUserId,
  setContactTags,
} from '@/lib/api/v1/contacts';
import { dispatchJourneyTrigger } from '@/lib/journeys/dispatch';

const LOOKBACK_MINUTES = 60;
const PAGE_SIZE = 50;
const MAX_PAGES = 5;
const CITY_FIELD = 'City';

interface Registration {
  _id: string;
  fullName?: string;
  whatsappNumber?: string;
  city?: string;
  email?: string;
  createdAt: string;
}

export interface LeadSyncReport {
  fetched: number;
  created: number;
  existing: number;
  skipped: number;
  errors: string[];
}

/** Indian numbers arrive as 10 digits; also accept 91XXXXXXXXXX, 0XXXXXXXXXX and +… */
export function toInternationalPhone(raw: string | undefined): string | null {
  const s = (raw ?? '').trim();
  const d = s.replace(/\D/g, '');
  if (s.startsWith('+')) return /^\d{8,15}$/.test(d) ? `+${d}` : null;
  if (/^[6-9]\d{9}$/.test(d)) return `+91${d}`;
  if (/^0[6-9]\d{9}$/.test(d)) return `+91${d.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(d)) return `+${d}`;
  return null;
}

async function fetchRecent(url: string, token: string | undefined, since: number): Promise<Registration[]> {
  const out: Registration[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const u = new URL(url);
    u.searchParams.set('page', String(page));
    u.searchParams.set('limit', String(PAGE_SIZE));
    const res = await fetch(u, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`source responded ${res.status}`);
    const body = (await res.json()) as { data?: Registration[]; totalPages?: number };
    const rows = body.data ?? [];
    let reachedOld = false;
    for (const r of rows) {
      if (Date.parse(r.createdAt) >= since) out.push(r);
      else reachedOld = true;
    }
    if (reachedOld || rows.length < PAGE_SIZE || page >= (body.totalPages ?? page)) break;
  }
  return out;
}

async function cityFieldId(db: SupabaseClient, accountId: string, userId: string): Promise<string | null> {
  const { data } = await db
    .from('custom_fields')
    .select('id')
    .eq('account_id', accountId)
    .ilike('field_name', CITY_FIELD)
    .limit(1)
    .maybeSingle();
  if (data?.id) return data.id as string;
  const { data: made } = await db
    .from('custom_fields')
    .insert({ account_id: accountId, user_id: userId, field_name: CITY_FIELD, field_type: 'text' })
    .select('id')
    .single();
  return (made?.id as string | undefined) ?? null;
}

/** Syncs every enabled source; one tiny query per tick when all are off. */
export async function runLeadSync(db: SupabaseClient, now = new Date()): Promise<Record<string, LeadSyncReport | { error: string }>> {
  const { data: sources, error } = await db
    .from('lead_sync_sources')
    .select('account_id, source_url, tag')
    .eq('enabled', true);
  if (error) throw error;

  const out: Record<string, LeadSyncReport | { error: string }> = {};
  for (const s of sources ?? []) {
    const report = await syncSource(db, s.account_id, s.source_url, s.tag, now).catch((err) => ({
      error: err instanceof Error ? err.message : String(err),
    }));
    out[s.account_id] = report;
    await db
      .from('lead_sync_sources')
      .update({ last_run_at: now.toISOString(), last_report: report })
      .eq('account_id', s.account_id);
  }
  return out;
}

async function syncSource(
  db: SupabaseClient,
  accountId: string,
  url: string,
  tag: string,
  now: Date
): Promise<LeadSyncReport> {
  const report: LeadSyncReport = { fetched: 0, created: 0, existing: 0, skipped: 0, errors: [] };
  const regs = await fetchRecent(url, process.env.LEAD_SYNC_SOURCE_TOKEN, now.getTime() - LOOKBACK_MINUTES * 60_000);
  report.fetched = regs.length;
  if (!regs.length) return report;

  const userId = await resolveAuditUserId(db, accountId);
  let cityId: string | null | undefined;

  // Oldest first, so journeys start in registration order.
  regs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const r of regs) {
    const phone = toInternationalPhone(r.whatsappNumber);
    if (!phone) {
      report.skipped++;
      continue;
    }
    try {
      const email = r.email?.trim();
      const { id, created } = await findOrCreateContact(db, accountId, userId, {
        phone,
        name: r.fullName?.trim() || undefined,
        email: email && email.includes('@') ? email : undefined,
      });
      if (!created) {
        report.existing++;
        continue;
      }
      report.created++;
      // Tags/city only on new contacts — setContactTags replaces the set.
      await setContactTags(db, accountId, userId, id, [tag]);
      const city = r.city?.trim();
      if (city) {
        if (cityId === undefined) cityId = await cityFieldId(db, accountId, userId);
        if (cityId) await db.from('contact_custom_values').insert({ contact_id: id, custom_field_id: cityId, value: city });
      }
      await dispatchJourneyTrigger(db, { accountId, contactId: id, trigger: 'contact_created', source: 'api' });
    } catch (err) {
      report.errors.push(`${r._id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return report;
}
