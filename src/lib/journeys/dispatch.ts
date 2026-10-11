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
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write';

import type { JourneyTriggerType } from './graph';
import {
  enrollContact,
  resumeOnReply,
  type JourneyDeps,
  type JourneyRow,
} from './engine';

export const liveJourneyDeps: JourneyDeps = {
  now: () => new Date(),
  async sendTemplate(ctx, cfg) {
    await engineSendTemplate({
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
    await engineSendText({
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      text,
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
}

/** Does this journey's trigger config match the event? */
export function triggerMatches(journey: Pick<JourneyRow, 'trigger_config'>, input: JourneyTriggerInput): boolean {
  const cfg = journey.trigger_config ?? {};
  if (input.trigger === 'tag_added') return Boolean(cfg.tag_id) && cfg.tag_id === input.tagId;
  if (input.trigger === 'button_clicked') {
    const want = cfg.button_text?.trim().toLowerCase();
    return !want || want === input.buttonText?.trim().toLowerCase();
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
      const r = await enrollContact(db, journey, input.contactId, deps, {
        trigger: input.trigger,
        ...(input.tagId ? { tag_id: input.tagId } : {}),
        ...(input.buttonText ? { button_text: input.buttonText } : {}),
      });
      if (r.enrolled) enrolled++;
    }
    return enrolled;
  } catch (err) {
    console.error('[journeys] trigger dispatch failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}

/** Every inbound customer message: resume replies, then start button / first-message journeys. */
export async function dispatchJourneyInbound(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; buttonText?: string | null },
  deps: JourneyDeps = liveJourneyDeps
): Promise<void> {
  try {
    if (!(await accountHasFeature(db, args.accountId, 'journeys'))) return;
    await resumeOnReply(db, args.accountId, args.contactId, deps);
    if (args.buttonText) {
      await dispatchJourneyTrigger(
        db,
        { accountId: args.accountId, contactId: args.contactId, trigger: 'button_clicked', buttonText: args.buttonText },
        deps
      );
    }
  } catch (err) {
    console.error('[journeys] inbound dispatch failed:', err instanceof Error ? err.message : err);
  }
}
