// ============================================================
// Callback timeline + "Send payment link" (migration 099).
//
// logCallbackEvent — best effort; a failed log never breaks the action.
// sendCallbackPaymentLink — the team sends the payment link from a
//   callback card. Inside WhatsApp's 24h window it goes as the same text
//   the journey sends; outside it, through the approved Utility template
//   sg_general_update (if the account has it). It is recorded like a
//   customer-requested link (payment_link_state), so the journey's
//   automatic link stays at most once, and the lead gets the
//   payment_link_sent tag.
//
// "Send message" (104) does NOT live here — it reuses startFollowUp
// (src/lib/callbacks/followups.ts) with kind 'missed', the exact "we
// tried calling you" journey step a 2nd "No answer" already triggers
// automatically. No separate template/message is invented for it.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { engineSendTemplate, engineSendText } from '@/lib/automations/meta-send';
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write';
import { ensureConversation } from '@/lib/journeys/engine';
import { claimPaymentLink } from '@/lib/payments/link-once';

export type CallbackEventKind = 'status' | 'note' | 'payment_link';

export async function logCallbackEvent(
  db: SupabaseClient,
  e: { accountId: string; callbackId: string; contactId: string | null; kind: CallbackEventKind; value?: string | null; detail?: string | null; actorId: string | null }
) {
  try {
    const { error } = await db.from('callback_events').insert({
      account_id: e.accountId,
      callback_id: e.callbackId,
      contact_id: e.contactId,
      kind: e.kind,
      value: e.value ?? null,
      detail: e.detail ?? null,
      actor_id: e.actorId,
    });
    if (error) console.error('[callbacks] timeline log failed:', error.message);
  } catch (err) {
    console.error('[callbacks] timeline log failed:', err instanceof Error ? err.message : err);
  }
}

const GENERAL_TEMPLATE = 'sg_general_update';
const WINDOW_MS = 24 * 3600_000;

/** The payment link set in the account's live journey ("Settings (edit me)" step). */
export async function accountPaymentLink(db: SupabaseClient, accountId: string): Promise<string | null> {
  const { data } = await db.from('journeys').select('graph').eq('account_id', accountId).eq('status', 'active');
  for (const j of data ?? []) {
    const nodes = ((j.graph as { nodes?: { type: string; config?: { assignments?: { key?: string; value?: unknown }[] } }[] } | null)?.nodes ?? []);
    for (const n of nodes) {
      if (n.type !== 'set_variable') continue;
      const hit = (n.config?.assignments ?? []).find((a) => a.key === 'payment_link');
      const v = typeof hit?.value === 'string' ? hit.value.trim() : '';
      // Sent exactly as the journey sends it (e.g. "razorpay.me/@name" works too).
      if (/^(https?:\/\/)?[\w-]+(\.[\w-]+)+\/?\S*$/i.test(v) && !/PASTE-/i.test(v)) return v;
    }
  }
  return null;
}

export async function generalTemplateApproved(db: SupabaseClient, accountId: string): Promise<boolean> {
  const { data } = await db
    .from('message_templates')
    .select('status')
    .eq('account_id', accountId)
    .eq('name', GENERAL_TEMPLATE)
    .limit(1)
    .maybeSingle();
  return String(data?.status ?? '').toUpperCase() === 'APPROVED';
}

export class PaymentLinkError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export async function sendCallbackPaymentLink(
  db: SupabaseClient,
  args: { accountId: string; userId: string; callbackId: string }
): Promise<{ via: 'text' | 'template' }> {
  const { data: req } = await db
    .from('callback_requests')
    .select('id, contact_id, conversation_id, contacts(name)')
    .eq('id', args.callbackId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (!req) throw new PaymentLinkError('Request not found', 404);
  const contactId = req.contact_id as string;
  const contact = (Array.isArray(req.contacts) ? req.contacts[0] : req.contacts) as { name?: string | null } | null;
  const name = (contact?.name ?? '').trim() || 'there';

  const link = await accountPaymentLink(db, args.accountId);
  if (!link) throw new PaymentLinkError('No payment link is set up yet — add it in the journey’s Settings step.');

  const conversationId = (req.conversation_id as string | null) ?? (await ensureConversation(db, args.accountId, contactId, args.userId));
  const { data: conv } = await db.from('conversations').select('last_customer_message_at').eq('id', conversationId).maybeSingle();
  const lastIn = Date.parse(String(conv?.last_customer_message_at ?? ''));
  const windowOpen = Number.isFinite(lastIn) && Date.now() - lastIn < WINDOW_MS;

  let via: 'text' | 'template';
  if (windowOpen) {
    await engineSendText({
      accountId: args.accountId,
      userId: args.userId,
      conversationId,
      contactId,
      text: `Great decision, ${name}! 🎉\n\nHere's your link to join Revibe:\n${link}\n\nReply here if you have any questions.\n\n— Swapnil Gautam`,
    });
    via = 'text';
  } else {
    if (!(await generalTemplateApproved(db, args.accountId))) {
      throw new PaymentLinkError('The lead has not messaged in the last 24 hours, so WhatsApp needs an approved template (sg_general_update) to send the link.');
    }
    await engineSendTemplate({
      accountId: args.accountId,
      userId: args.userId,
      conversationId,
      contactId,
      templateName: GENERAL_TEMPLATE,
      language: 'en_US',
      params: [name, `Here is your payment link to join Revibe: ${link}`],
    });
    via = 'template';
  }

  // Record it like a customer-requested link: automatic resends stay blocked.
  await claimPaymentLink(db, {
    accountId: args.accountId,
    contactId,
    journeyId: null,
    nodeId: 'callback_manual',
    config: { on_request: true, text: '{{ vars.payment_link }}' },
  }).catch(() => null);
  const { data: tag } = await db.from('tags').select('id').eq('account_id', args.accountId).ilike('name', 'payment_link_sent').limit(1).maybeSingle();
  if (tag) await addContactTagIfAbsent(db, { accountId: args.accountId, contactId, tagId: tag.id as string }).catch(() => false);

  await logCallbackEvent(db, {
    accountId: args.accountId,
    callbackId: args.callbackId,
    contactId,
    kind: 'payment_link',
    value: via,
    detail: link,
    actorId: args.userId,
  });
  return { via };
}

