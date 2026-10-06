// ============================================================
// Button-click tracking (migration 046).
//
// Called by the WhatsApp webhook after an inbound message is stored
// (past its idempotency check). If the message is a button tap, record
// it and credit it to the message that carried the button:
//
//   context.id → broadcast_recipients.whatsapp_message_id → broadcast
//              → messages.message_id (same conversation)  → inbox / bot
//
// Best-effort and never throws: analytics must not break message
// handling.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { accountHasFeature } from '@/lib/features-server';

export type ButtonKind = 'template_quick_reply' | 'interactive_button' | 'interactive_list';

export interface ButtonTap {
  kind: ButtonKind;
  text: string | null;
  payload: string | null;
  /** wamid of the message whose button was tapped. */
  contextId: string | null;
}

/** Minimal shape of a Meta inbound message we read here. */
export interface InboundForClick {
  type: string;
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  context?: { id: string };
}

/** The tap carried by an inbound message, or null if it isn't one. */
export function extractButtonTap(message: InboundForClick): ButtonTap | null {
  const contextId = message.context?.id ?? null;
  if (message.type === 'button' && message.button) {
    return {
      kind: 'template_quick_reply',
      text: message.button.text || null,
      payload: message.button.payload || null,
      contextId,
    };
  }
  if (message.type === 'interactive') {
    const button = message.interactive?.button_reply;
    if (button) {
      return { kind: 'interactive_button', text: button.title || null, payload: button.id || null, contextId };
    }
    const row = message.interactive?.list_reply;
    if (row) {
      return { kind: 'interactive_list', text: row.title || null, payload: row.id || null, contextId };
    }
  }
  return null;
}

/** Carousel card from the default payload the send builder uses (card_<n>_btn_<m>). */
export function cardIndexFromPayload(payload: string | null): number | null {
  const m = payload ? /^card_(\d+)_btn_\d+$/.exec(payload) : null;
  return m ? Number(m[1]) : null;
}

interface Attribution {
  source: 'broadcast' | 'inbox' | 'bot' | 'unknown';
  broadcast_id: string | null;
  broadcast_recipient_id: string | null;
  template_name: string | null;
}

async function attribute(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  contextId: string | null
): Promise<Attribution> {
  const none: Attribution = {
    source: 'unknown',
    broadcast_id: null,
    broadcast_recipient_id: null,
    template_name: null,
  };
  if (!contextId) return none;

  // 1. A broadcast send. Scoped to this account through the join so a
  //    forged context id can't credit another tenant's broadcast.
  const { data: recipient } = await db
    .from('broadcast_recipients')
    .select('id, broadcast_id, broadcasts!inner(account_id, template_name)')
    .eq('whatsapp_message_id', contextId)
    .eq('broadcasts.account_id', accountId)
    .maybeSingle();
  if (recipient) {
    const bc = (Array.isArray(recipient.broadcasts) ? recipient.broadcasts[0] : recipient.broadcasts) as
      | { template_name?: string }
      | undefined;
    return {
      source: 'broadcast',
      broadcast_id: recipient.broadcast_id as string,
      broadcast_recipient_id: recipient.id as string,
      template_name: bc?.template_name ?? null,
    };
  }

  // 2. A message sent in this conversation (agent template from the
  //    inbox, or a flow/automation/AI bot message).
  const { data: msg } = await db
    .from('messages')
    .select('sender_type, template_name')
    .eq('conversation_id', conversationId)
    .eq('message_id', contextId)
    .maybeSingle();
  if (msg) {
    return {
      source: msg.sender_type === 'bot' ? 'bot' : msg.sender_type === 'agent' ? 'inbox' : 'unknown',
      broadcast_id: null,
      broadcast_recipient_id: null,
      template_name: (msg.template_name as string | null) ?? null,
    };
  }
  return none;
}

export async function recordButtonClick(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    conversationId: string;
    /** Our messages.id for the inbound tap. */
    messageRowId: string;
    waMessageId: string;
    message: InboundForClick;
    clickedAt: Date;
  }
): Promise<'recorded' | 'not_a_click' | 'feature_off' | 'failed'> {
  const tap = extractButtonTap(args.message);
  if (!tap) return 'not_a_click';

  try {
    if (!(await accountHasFeature(db, args.accountId, 'button_analytics'))) return 'feature_off';

    const attribution = await attribute(db, args.accountId, args.conversationId, tap.contextId);
    const { error } = await db.from('button_clicks').upsert(
      {
        account_id: args.accountId,
        contact_id: args.contactId,
        conversation_id: args.conversationId,
        message_id: args.messageRowId,
        wa_message_id: args.waMessageId,
        context_wa_message_id: tap.contextId,
        button_kind: tap.kind,
        button_text: tap.text,
        button_payload: tap.payload,
        card_index: cardIndexFromPayload(tap.payload),
        ...attribution,
        clicked_at: args.clickedAt.toISOString(),
      },
      { onConflict: 'message_id', ignoreDuplicates: true }
    );
    if (error) throw new Error(error.message);
    return 'recorded';
  } catch (err) {
    console.error('[button-clicks] record failed:', err instanceof Error ? err.message : err);
    return 'failed';
  }
}
