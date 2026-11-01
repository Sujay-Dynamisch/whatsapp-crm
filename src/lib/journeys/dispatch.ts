// ============================================================
// Journey triggers + production dependencies (migration 050).
//
// Called from the webhook (first message, reply, button tap) and from
// the automation trigger fan-out (new contact, tag added). Best effort:
// never throws into the caller — a journey problem must not break
// message handling.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { accountHasFeature } from '@/lib/features-server';
import { engineSendTemplate, engineSendText } from '@/lib/automations/meta-send';
import { engineSendInteractiveButtons, engineSendMedia } from '@/lib/flows/meta-send';
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write';

import { findTrigger, type JourneyTriggerType, type TriggerConfig } from './graph';
import { sendJourneyFallbacks } from './messages';
import {
  enrollContact,
  ensureConversation,
  resumeOnReply,
  startContext,
  type JourneyDeps,
  type JourneyRow,
} from './engine';

export const liveJourneyDeps: JourneyDeps = {
  now: () => new Date(),
  async sendTemplate(ctx, cfg) {
    return engineSendTemplate({
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      templateName: cfg.template_name,
      language: cfg.language,
      params: cfg.params ?? [],
    });
  },
  async sendText(ctx, text) {
    return engineSendText({
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      text,
    });
  },
  async sendMedia(ctx, cfg) {
    return engineSendMedia({
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      kind: cfg.media_type,
      link: cfg.url,
      caption: cfg.caption,
      filename: cfg.filename,
    });
  },
  async sendButtons(ctx, cfg) {
    return engineSendInteractiveButtons({
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      bodyText: cfg.text,
      buttons: cfg.buttons,
      headerText: cfg.header,
      footerText: cfg.footer,
    });
  },
  async addTag(ctx, tagId) {
    // Plain write: a journey adding a tag does not re-fan-out tag_added
    // here, which keeps journey ↔ automation chains bounded.
    const { supabaseAdmin } = await import('@/lib/flows/admin-client');
    await addContactTagIfAbsent(supabaseAdmin(), {
      accountId: ctx.accountId,
      contactId: ctx.contactId,
      tagId,
    });
  },
};

export interface JourneyTriggerInput {
  accountId: string;
  contactId: string;
  trigger: JourneyTriggerType;
  tagId?: string;
  buttonText?: string;
  /** inbound_message: the customer's text. */
  text?: string;
  /** contact_created: 'api' (public API) or 'whatsapp' (inbox auto-created on a first message). */
  source?: 'api' | 'whatsapp';
  /** Extra trigger data for the run ({{ trigger.… }}), e.g. the website registration id. */
  data?: Record<string, unknown>;
}

/** Does this journey's trigger config match the event? */
export function triggerMatches(journey: Pick<JourneyRow, 'trigger_config'>, input: JourneyTriggerInput): boolean {
  const cfg = journey.trigger_config ?? {};
  if (input.trigger === 'contact_created') {
    const want = cfg.contact_source;
    return want !== 'api' && want !== 'whatsapp' ? true : want === input.source;
  }
  if (input.trigger === 'tag_added') return Boolean(cfg.tag_id) && cfg.tag_id === input.tagId;
  if (input.trigger === 'button_clicked') {
    const want = cfg.button_text?.trim().toLowerCase();
    return !want || want === input.buttonText?.trim().toLowerCase();
  }
  if (input.trigger === 'inbound_message') {
    const keyword = cfg.keyword?.trim().toLowerCase();
    if (!keyword) return true;
    const text = (input.text ?? '').trim().toLowerCase();
    return cfg.match_type === 'exact' ? text === keyword : text.includes(keyword);
  }
  return true;
}

export async function dispatchJourneyTrigger(
  db: SupabaseClient,
  input: JourneyTriggerInput,
  deps: JourneyDeps = liveJourneyDeps
): Promise<number> {
  try {
    if (!(await accountHasFeature(db, input.accountId, 'journeys'))) return 0;
    const { data } = await db
      .from('journeys')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('status', 'active')
      .eq('trigger_type', input.trigger);

    let enrolled = 0;
    for (const journey of (data ?? []) as JourneyRow[]) {
      if (!triggerMatches(journey, input)) continue;
      const r = await enrollContact(
        db,
        journey,
        input.contactId,
        deps,
        startContext(input.trigger, {
          ...(input.data ?? {}),
          ...(input.tagId ? { tag_id: input.tagId } : {}),
          ...(input.buttonText ? { button_text: input.buttonText } : {}),
          ...(input.text !== undefined ? { text: input.text } : {}),
        })
      );
      if (r.enrolled) enrolled++;
    }
    return enrolled;
  } catch (err) {
    console.error('[journeys] trigger dispatch failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}

export interface ReregistrationInput {
  accountId: string;
  contactId: string;
  /** The registration's id at the source — a run is started once per registration. */
  registrationId: string;
  /** When they registered (ISO). Registrations older than the contact's latest run are ignored. */
  registeredAt: string;
}

/**
 * An existing contact registered again (website lead sync): restart the
 * account's "contact created (API)" journeys for them, so they get the
 * confirmation and reminders for their new webinar.
 *
 * Skipped when the contact opted out or carries one of the journey's
 * exit tags (paid / closed), when this registration already started a
 * run, or when the registration is older than their latest run (the
 * lead sync re-reads the last hour every minute). A run that is
 * executing a step right now is left alone; the next sync retries.
 * Never throws.
 */
export async function restartJourneysOnReregistration(
  db: SupabaseClient,
  input: ReregistrationInput,
  deps: JourneyDeps = liveJourneyDeps
): Promise<number> {
  try {
    if (!(await accountHasFeature(db, input.accountId, 'journeys'))) return 0;
    const registeredAt = Date.parse(input.registeredAt);
    if (!input.registrationId || !Number.isFinite(registeredAt)) return 0;

    const { data: journeys } = await db
      .from('journeys')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('status', 'active')
      .eq('trigger_type', 'contact_created');
    const matching = ((journeys ?? []) as JourneyRow[]).filter((j) =>
      triggerMatches(j, { accountId: input.accountId, contactId: input.contactId, trigger: 'contact_created', source: 'api' })
    );
    if (!matching.length) return 0;

    const { data: tagRows } = await db.from('contact_tags').select('tag_id, tags(name)').eq('contact_id', input.contactId);
    const tags = (tagRows ?? []) as { tag_id: string; tags?: { name?: string } | { name?: string }[] | null }[];
    const optedOut = tags.some((r) => {
      const t = Array.isArray(r.tags) ? r.tags[0] : r.tags;
      return (t?.name ?? '').trim().toLowerCase() === 'unsubscribe';
    });
    if (optedOut) return 0;

    let started = 0;
    for (const journey of matching) {
      const exitIds = (findTrigger(journey.graph)?.config as TriggerConfig | undefined)?.exit_tag_ids ?? [];
      if (tags.some((r) => exitIds.includes(r.tag_id))) continue;

      const { data: runs } = await db
        .from('journey_enrollments')
        .select('id, status, entered_at, context')
        .eq('journey_id', journey.id)
        .eq('contact_id', input.contactId);
      const list = (runs ?? []) as { id: string; status: string; entered_at: string; context?: Record<string, unknown> | null }[];
      const regId = (r: (typeof list)[number]) =>
        ((r.context?.trigger_data ?? {}) as Record<string, unknown>).registration_id;
      if (list.some((r) => regId(r) === input.registrationId)) continue;
      const latest = Math.max(0, ...list.map((r) => Date.parse(r.entered_at) || 0));
      if (registeredAt <= latest) continue;
      if (list.some((r) => r.status === 'active')) continue; // mid-step; retried next sync

      // End the old run (only a parked one, atomically) before starting fresh.
      const live = list.filter((r) => r.status === 'waiting').map((r) => r.id);
      if (live.length) {
        await db
          .from('journey_enrollments')
          .update({
            status: 'exited',
            wait_kind: null,
            locked_at: null,
            last_error: 'Registered again — restarted',
            completed_at: deps.now().toISOString(),
          })
          .in('id', live)
          .eq('status', 'waiting');
      }

      const r = await enrollContact(
        db,
        journey,
        input.contactId,
        deps,
        startContext('contact_created', {
          source: 'api',
          reregistered: true,
          registration_id: input.registrationId,
          registered_at: input.registeredAt,
        }),
        { reentry: true }
      );
      if (r.enrolled) started++;
    }
    return started;
  } catch (err) {
    console.error('[journeys] re-registration restart failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}

/**
 * Every inbound customer message: resume replies (with the reply text
 * as {{ reply.text }}), then start message / keyword and button
 * journeys.
 *
 * Returns true when a journey handled the message (resumed a reply
 * wait, re-sent a fallback, or started a run). The journey's own
 * predefined replies then answer it, so the caller skips the AI
 * auto-reply — no double answer and no LLM tokens spent.
 */
export async function dispatchJourneyInbound(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; buttonText?: string | null; text?: string | null },
  deps: JourneyDeps = liveJourneyDeps
): Promise<boolean> {
  try {
    if (!(await accountHasFeature(db, args.accountId, 'journeys'))) return false;
    const text = args.text ?? args.buttonText ?? '';
    // The 24-hour window just opened: re-send undelivered journey
    // templates (e.g. Meta's 131049 "healthy ecosystem engagement") as text.
    const fellBack = await sendJourneyFallbacks(
      db,
      { accountId: args.accountId, contactId: args.contactId, inboundText: text, now: deps.now() },
      async (row, body) => {
        const { data: j } = await db.from('journeys').select('created_by').eq('id', row.journey_id).maybeSingle();
        const userId = (j?.created_by as string | null) ?? null;
        return deps.sendText(
          {
            accountId: args.accountId,
            userId: userId ?? '',
            contactId: args.contactId,
            conversationId: await ensureConversation(db, args.accountId, args.contactId, userId),
          },
          body
        );
      }
    );
    let handled = fellBack.size > 0;
    handled =
      (await resumeOnReply(db, args.accountId, args.contactId, deps, { text, button: args.buttonText ?? null }, fellBack)) > 0 ||
      handled;
    handled =
      (await dispatchJourneyTrigger(
        db,
        { accountId: args.accountId, contactId: args.contactId, trigger: 'inbound_message', text },
        deps
      )) > 0 || handled;
    if (args.buttonText) {
      handled =
        (await dispatchJourneyTrigger(
          db,
          { accountId: args.accountId, contactId: args.contactId, trigger: 'button_clicked', buttonText: args.buttonText },
          deps
        )) > 0 || handled;
    }
    return handled;
  } catch (err) {
    console.error('[journeys] inbound dispatch failed:', err instanceof Error ? err.message : err);
    return false;
  }
}
