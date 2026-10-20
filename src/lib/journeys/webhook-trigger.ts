// ============================================================
// Webhook trigger (migration 054): an external system POSTs JSON to
// /api/journeys/hooks/<token>; the journey's trigger maps the customer
// out of the payload, we find or create that contact and start a run
// with the payload as {{ trigger.body }}.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { isValidE164, parseInternationalPhone } from '@/lib/whatsapp/phone-utils';

import { findTrigger } from './graph';
import { emptyScope, renderTemplate } from './expressions';
import { enrollContact, startContext, type JourneyDeps, type JourneyRow } from './engine';

export interface WebhookPayload {
  body: unknown;
  query: Record<string, string>;
  headers: Record<string, string>;
  method: string;
}

/**
 * Turn whatever the payload holds into the digits-only international
 * form Meta uses. `+…` numbers are trusted as international; bare
 * numbers of 10 digits or fewer get `defaultCountryCode` (a leading
 * trunk 0 dropped); a 00 prefix is the international dialling prefix.
 */
export function normalizeWebhookPhone(raw: string, defaultCountryCode?: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('+')) return parseInternationalPhone(s);
  let digits = s.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (defaultCountryCode && digits.length <= 11) {
    digits = defaultCountryCode + digits.replace(/^0/, '');
  }
  return isValidE164(digits) ? digits : null;
}

export type WebhookOutcome =
  | { ok: true; contactId: string; enrolled: boolean; reason?: string; outcome?: string }
  | { ok: false; status: number; error: string };

export async function enrollFromWebhook(
  db: SupabaseClient,
  journey: JourneyRow,
  payload: WebhookPayload,
  deps: JourneyDeps
): Promise<WebhookOutcome> {
  const cfg = findTrigger(journey.graph)?.config;
  if (!cfg || cfg.trigger_type !== 'webhook') return { ok: false, status: 409, error: 'This journey is not started by a webhook' };

  const scope = { ...emptyScope(deps.now()), trigger: { ...payload } as Record<string, unknown> };
  const rawPhone = renderTemplate(cfg.phone ?? '', scope);
  const phone = normalizeWebhookPhone(rawPhone, cfg.default_country_code);
  if (!phone) {
    return {
      ok: false,
      status: 422,
      error: rawPhone
        ? `"${rawPhone.slice(0, 40)}" is not a valid phone number — send it with the country code, e.g. +919876543210`
        : `No phone number found at ${cfg.phone} in the payload`,
    };
  }
  const name = cfg.name ? renderTemplate(cfg.name, scope).trim().slice(0, 200) : '';

  let contactId: string;
  const existing = await findExistingContact(db, journey.account_id, phone);
  if (existing) {
    contactId = existing.id;
  } else {
    const { data: owner } = await db
      .from('whatsapp_config')
      .select('user_id')
      .eq('account_id', journey.account_id)
      .maybeSingle();
    const { data: created, error } = await db
      .from('contacts')
      .insert({
        account_id: journey.account_id,
        user_id: owner?.user_id ?? journey.created_by,
        phone,
        name: name || null,
      })
      .select('id')
      .single();
    if (error && isUniqueViolation(error)) {
      const again = await findExistingContact(db, journey.account_id, phone);
      if (!again) return { ok: false, status: 500, error: 'Could not create the contact' };
      contactId = again.id;
    } else if (error || !created) {
      return { ok: false, status: 500, error: 'Could not create the contact' };
    } else {
      contactId = created.id as string;
    }
  }

  const r = await enrollContact(db, journey, contactId, deps, startContext('webhook', { ...payload }));
  return { ok: true, contactId, enrolled: r.enrolled, reason: r.reason, outcome: r.outcome };
}
