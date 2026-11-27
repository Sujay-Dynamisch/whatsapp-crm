// ============================================================
// Callbacks → "Not on WhatsApp" tab: a caller got the lead's real WhatsApp number —
// save it and start the WhatsApp journey again at a step the caller picks.
// Options are plain language for non-technical teams; only steps that
// exist in the account's journey are offered.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { enrollContact, startContext, type JourneyRow, type JourneyDeps } from '@/lib/journeys/engine';
import { carriedContext } from '@/lib/journeys/restart';
import { clearNotOnWhatsApp, stopLiveRuns } from './not-on-whatsapp';

export interface RestartStep {
  id: string;
  label: string;
  hint: string;
  /** Journey step to start at; null = from the very beginning. */
  node: string | null;
}

/** In journey order, the way a lead moves through it. */
const STEPS: RestartStep[] = [
  { id: 'start', label: 'From the beginning', hint: 'Registration message with the next webinar date, then all reminders.', node: null },
  { id: 'reinvite', label: 'Invite to the next webinar', hint: 'The "next session" invitation with the date and link, then reminders.', node: 'set_auto_reinvite' },
  { id: 'checkin', label: 'After the webinar — options menu', hint: 'Join the program / Testimonials / Questions / Request a call.', node: 't3_checkin' },
  { id: 'payment', label: 'Send the payment link', hint: 'Payment link now, then two gentle payment reminders.', node: 'pay_link' },
  { id: 'testimonials', label: 'Send testimonials', hint: 'Success stories, then "Join or talk to our team?".', node: 'testimonials' },
  { id: 'faq', label: 'Send the FAQ menu', hint: 'Top questions; they reply with a number to get the answer.', node: 'faq' },
  { id: 'nurture', label: 'Follow-up messages only', hint: 'A friendly message every 2nd day at 11 AM for about 15 days.', node: 'c_slot' },
];

/** The account's webinar journey (the one new registrations start). */
async function funnelJourney(db: SupabaseClient, accountId: string): Promise<JourneyRow | null> {
  const { data } = await db
    .from('journeys')
    .select('*')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .eq('trigger_type', 'contact_created')
    .order('activated_at', { ascending: true })
    .limit(1);
  return ((data ?? [])[0] as JourneyRow | undefined) ?? null;
}

/** Steps offered for this account (those that exist in its journey). */
export async function restartSteps(db: SupabaseClient, accountId: string): Promise<RestartStep[]> {
  const journey = await funnelJourney(db, accountId);
  if (!journey) return [];
  const ids = new Set(journey.graph.nodes.map((n) => n.id));
  return STEPS.filter((s) => s.node === null || ids.has(s.node));
}

/** Digits only; a 10-digit Indian mobile gets the 91 country code. Null if invalid. */
export function normalizePhone(raw: string): string | null {
  const d = raw.replace(/\D/g, '').replace(/^0+/, '');
  const full = d.length === 10 ? `91${d}` : d;
  return /^\d{11,15}$/.test(full) ? full : null;
}

/**
 * Save the corrected number (optional) and start the journey at `stepId`.
 * The "not on WhatsApp" mark is lifted and the old failed messages are
 * closed so they don't re-send. The first message goes out right away.
 */
export async function fixNumberAndRestart(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; phone?: string | null; stepId: string },
  deps: JourneyDeps
): Promise<{ ok: true; started: boolean } | { ok: false; error: string; status: number }> {
  const journey = await funnelJourney(db, args.accountId);
  if (!journey) return { ok: false, error: 'There is no active webinar journey.', status: 409 };
  const step = (await restartSteps(db, args.accountId)).find((s) => s.id === args.stepId);
  if (!step) return { ok: false, error: 'Pick where the WhatsApp messages should start.', status: 400 };

  if (args.phone) {
    const phone = normalizePhone(args.phone);
    if (!phone) return { ok: false, error: 'Enter a valid WhatsApp number (10 digits, or with country code).', status: 400 };
    const { data: other } = await db
      .from('contacts')
      .select('id, name')
      .eq('account_id', args.accountId)
      .eq('phone', phone)
      .neq('id', args.contactId)
      .maybeSingle();
    if (other) return { ok: false, error: `Another contact (${other.name || phone}) already has this number.`, status: 409 };
    const { error } = await db.from('contacts').update({ phone }).eq('id', args.contactId).eq('account_id', args.accountId);
    if (error) return { ok: false, error: error.message, status: 400 };
  }

  await clearNotOnWhatsApp(db, args.accountId, args.contactId);
  await db
    .from('journey_messages')
    .update({ resolved: 'superseded', resolved_at: new Date().toISOString() })
    .eq('contact_id', args.contactId)
    .eq('status', 'failed')
    .is('resolved', null);
  await stopLiveRuns(db, args.contactId, deps.now());

  const { data: last } = await db
    .from('journey_enrollments')
    .select('context')
    .eq('journey_id', journey.id)
    .eq('contact_id', args.contactId)
    .order('entered_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const base = { trigger: 'manual', trigger_data: { type: 'manual', reason: 'whatsapp_number_fixed' } };
  const r = step.node
    ? await enrollContact(
        db,
        journey,
        args.contactId,
        deps,
        { ...base, ...carriedContext(journey.graph, (last?.context ?? null) as Record<string, unknown> | null, step.node) },
        { reentry: true, startAt: step.node }
      )
    : await enrollContact(db, journey, args.contactId, deps, { ...startContext('manual'), ...base }, { reentry: true });
  return { ok: true, started: r.enrolled };
}
