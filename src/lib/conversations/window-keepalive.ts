// ============================================================
// 24-hour window keep-alive (migration 044).
//
// WhatsApp accepts free-form messages only within 24h of the
// customer's last message. Shortly before that window closes, send the
// account's configured check-in text once, so a customer who replies
// re-opens the window for another 24h.
//
// The sweep is driven by Cloud Scheduler (every 5 min) through the
// `windowKeepalive` Cloud Function. All selection logic — timing,
// once-per-window, closed conversations, quiet period, unsubscribed
// contacts — lives in `claim_window_keepalives()`, which also stamps
// the claim atomically, so overlapping sweeps can't double-send.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { engineSendText } from '@/lib/flows/meta-send';

export interface ClaimedKeepalive {
  conversation_id: string;
  account_id: string;
  contact_id: string;
  window_opened_at: string;
  message_text: string;
}

export interface KeepaliveReport {
  claimed: number;
  sent: string[];
  failed: { conversationId: string; error: string }[];
}

type SendText = typeof engineSendText;

export async function runWindowKeepalive(
  db: SupabaseClient,
  opts: { limit?: number; send?: SendText } = {}
): Promise<KeepaliveReport> {
  const send = opts.send ?? engineSendText;
  const report: KeepaliveReport = { claimed: 0, sent: [], failed: [] };

  const { data, error } = await db.rpc('claim_window_keepalives', {
    p_limit: opts.limit ?? 100,
  });
  if (error) throw new Error(`claim_window_keepalives failed: ${error.message}`);

  const rows = (data ?? []) as ClaimedKeepalive[];
  report.claimed = rows.length;

  // engineSendText's userId is an audit field; use the WhatsApp config
  // owner, as the AI auto-reply does. One lookup per account.
  const owners = new Map<string, string>();
  const ownerOf = async (accountId: string): Promise<string> => {
    if (!owners.has(accountId)) {
      const { data: cfg } = await db
        .from('whatsapp_config')
        .select('user_id')
        .eq('account_id', accountId)
        .maybeSingle();
      owners.set(accountId, (cfg?.user_id as string | undefined) ?? '');
    }
    return owners.get(accountId)!;
  };

  for (const row of rows) {
    try {
      await send({
        accountId: row.account_id,
        userId: await ownerOf(row.account_id),
        conversationId: row.conversation_id,
        contactId: row.contact_id,
        text: row.message_text,
      });
      await db
        .from('conversations')
        .update({ window_keepalive_sent_at: new Date().toISOString() })
        .eq('id', row.conversation_id);
      report.sent.push(row.conversation_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.failed.push({ conversationId: row.conversation_id, error: message });
      // Release the claim so the next sweep can retry while the window
      // is still open — but only if no newer customer message has
      // already moved the window on.
      await db
        .from('conversations')
        .update({ window_keepalive_for: null })
        .eq('id', row.conversation_id)
        .eq('window_keepalive_for', row.window_opened_at);
    }
  }

  return report;
}

export {
  DEFAULT_KEEPALIVE_SETTINGS,
  parseKeepaliveSettings,
  type KeepaliveSettings,
} from './window-keepalive-settings';
