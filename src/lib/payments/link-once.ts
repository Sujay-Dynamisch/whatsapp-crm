// ============================================================
// Payment link at most once per engagement (caller management, 087).
//
// Automatic sends only: a step marked `on_request` (the customer just
// tapped "Join" / asked for the link) always goes out and is recorded.
//
// A journey send step that uses {{ vars.payment_link }} is a payment-link
// send. Before the provider is called we reserve payment_link_state for
// the contact's open engagement (unique per engagement); a second step /
// retry / restart for the same engagement is skipped. A failed send
// releases the reservation so a retry can still deliver it. Leads from
// before engagements are keyed per contact. Only for accounts with
// 'caller_management'; everyone else sends exactly as before.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { accountHasFeature } from '@/lib/features-server';

export function referencesPaymentLink(config: unknown): boolean {
  return /vars\.payment_link\b/.test(JSON.stringify(config ?? ''));
}

export interface LinkClaim {
  /** false → already sent for this engagement: skip the step. */
  claimed: boolean;
  id: string | null;
}

/** null = not applicable (feature off / step doesn't carry the link). */
export async function claimPaymentLink(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; journeyId: string | null; nodeId: string; config: unknown }
): Promise<LinkClaim | null> {
  if (!referencesPaymentLink(args.config)) return null;
  if (!(await accountHasFeature(db, args.accountId, 'caller_management'))) return null;

  const { data: eng } = await db
    .from('engagements')
    .select('id')
    .eq('contact_id', args.contactId)
    .eq('status', 'open')
    .order('accepted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const engagementId = (eng?.id as string | undefined) ?? null;
  const key = engagementId ?? `contact:${args.contactId}`;
  const onRequest = (args.config as { on_request?: unknown } | null)?.on_request === true;

  if (onRequest) {
    // Customer asked: send, and record it so automatic resends stay blocked.
    await db.from('payment_link_state').upsert(
      {
        account_id: args.accountId,
        contact_id: args.contactId,
        engagement_id: engagementId,
        idem_key: key,
        journey_id: args.journeyId,
        node_id: args.nodeId,
        status: 'sent',
        sent_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,idem_key', ignoreDuplicates: true }
    );
    return null;
  }

  const { data, error } = await db
    .from('payment_link_state')
    .insert({
      account_id: args.accountId,
      contact_id: args.contactId,
      engagement_id: engagementId,
      idem_key: key,
      journey_id: args.journeyId,
      node_id: args.nodeId,
    })
    .select('id')
    .maybeSingle();
  if (error) {
    if (error.code === '23505') return { claimed: false, id: null };
    throw new Error(error.message);
  }
  return { claimed: true, id: (data?.id as string) ?? null };
}

export async function markPaymentLinkSent(db: SupabaseClient, claim: LinkClaim | null, waMessageId: string | null | undefined) {
  if (!claim?.id) return;
  await db
    .from('payment_link_state')
    .update({ status: 'sent', wa_message_id: waMessageId ?? null, sent_at: new Date().toISOString() })
    .eq('id', claim.id);
}

export async function releasePaymentLink(db: SupabaseClient, claim: LinkClaim | null) {
  if (!claim?.id) return;
  await db.from('payment_link_state').delete().eq('id', claim.id).eq('status', 'reserved');
}
