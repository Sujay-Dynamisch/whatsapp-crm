// ============================================================
// A lost lead writes back (journey trigger settings revive_tag_id +
// revive_node; migration 061).
//
// When a customer message arrives and the contact has no live run but
// carries a journey's "lost" tag (e.g. closed_lost):
//   * the team is told — owners/admins and the chat's assignee get a
//     'lead_returned' notification (top-right popup → open the chat);
//   * the lost tag comes off and a new run starts at revive_node with
//     their message as {{ reply.text }} (e.g. answer a menu choice
//     straight away, else send the menu again). The last run's settings
//     carry over.
// Leads who opted out (STOP / unsubscribe tag) or have one of the
// journey's exit tags (paid / "not proceeding") get no automated message;
// the team is still told unless they opted out. Never throws.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUnsubscribeText } from '@/lib/contacts/unsubscribe';
import { enrollContact, type JourneyDeps, type JourneyRow } from './engine';
import { findTrigger, type TriggerConfig } from './graph';
import { carriedContext } from './restart';

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export type ReviveOutcome = 'restarted' | 'notified' | 'none';

async function notifyTeam(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; text: string; restarted: boolean }
): Promise<void> {
  const [{ data: contact }, { data: conv }, { data: profiles }] = await Promise.all([
    db.from('contacts').select('name, phone').eq('id', args.contactId).maybeSingle(),
    db.from('conversations').select('id, assigned_agent_id').eq('account_id', args.accountId).eq('contact_id', args.contactId).maybeSingle(),
    db.from('profiles').select('user_id, account_role').eq('account_id', args.accountId),
  ]);
  const users = new Set(
    ((profiles ?? []) as { user_id: string; account_role?: string }[])
      .filter((p) => p.account_role === 'owner' || p.account_role === 'admin')
      .map((p) => p.user_id)
  );
  if (conv?.assigned_agent_id) users.add(conv.assigned_agent_id as string);
  if (!users.size) return;
  const name = String(contact?.name ?? '').trim();
  const phone = String(contact?.phone ?? '');
  const who = name && name !== phone ? `${name} · ${phone}` : phone || name;
  const said = args.text.trim() ? `: “${args.text.trim().slice(0, 140)}”` : '';
  await db.from('notifications').insert(
    [...users].map((user_id) => ({
      account_id: args.accountId,
      user_id,
      type: 'lead_returned',
      conversation_id: (conv?.id as string) ?? null,
      contact_id: args.contactId,
      title: args.restarted ? 'A lost lead wrote back — menu sent again' : 'A closed lead wrote back — please reply',
      body: `${who}${said}`,
    }))
  );
}

/** Handle a customer message from a lost lead. Call only when no run handled the message. */
export async function reviveLostLead(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; text: string },
  deps: JourneyDeps
): Promise<ReviveOutcome> {
  try {
    if (isUnsubscribeText(args.text)) return 'none';
    const { data: journeys } = await db.from('journeys').select('*').eq('account_id', args.accountId).eq('status', 'active');
    const reviving = ((journeys ?? []) as JourneyRow[]).filter((j) => {
      const c = (findTrigger(j.graph)?.config ?? {}) as TriggerConfig;
      return Boolean(c.revive_tag_id && c.revive_node);
    });
    if (!reviving.length) return 'none';

    const { data: tagRows } = await db.from('contact_tags').select('tag_id, tags(name)').eq('contact_id', args.contactId);
    const tags = (tagRows ?? []) as { tag_id: string; tags?: { name?: string } | { name?: string }[] | null }[];
    if (tags.some((r) => (one(r.tags)?.name ?? '').trim().toLowerCase() === 'unsubscribe')) return 'none';
    const tagIds = new Set(tags.map((r) => r.tag_id));

    for (const journey of reviving) {
      const cfg = (findTrigger(journey.graph)?.config ?? {}) as TriggerConfig;
      const { data: runs } = await db
        .from('journey_enrollments')
        .select('id, status, entered_at, context')
        .eq('journey_id', journey.id)
        .eq('contact_id', args.contactId);
      const list = (runs ?? []) as { id: string; status: string; entered_at: string; context: Record<string, unknown> | null }[];
      if (!list.length || list.some((r) => r.status === 'active' || r.status === 'waiting')) continue;

      const closed = (cfg.exit_tag_ids ?? []).some((id) => tagIds.has(id));
      if (closed) {
        // They said "not proceeding" / paid — a person should answer, not the bot.
        await notifyTeam(db, { ...args, restarted: false });
        return 'notified';
      }
      if (!tagIds.has(cfg.revive_tag_id!)) continue;

      const last = list.sort((a, b) => Date.parse(b.entered_at) - Date.parse(a.entered_at))[0];
      const { vars, nodes } = carriedContext(journey.graph, last.context, cfg.revive_node!);
      await db.from('contact_tags').delete().eq('contact_id', args.contactId).eq('tag_id', cfg.revive_tag_id!);
      const r = await enrollContact(
        db,
        journey,
        args.contactId,
        deps,
        {
          trigger: 'revived',
          trigger_data: { type: 'revived', text: args.text },
          vars,
          nodes,
          reply: { text: args.text, at: deps.now().toISOString() },
        },
        { reentry: true, startAt: cfg.revive_node }
      );
      await notifyTeam(db, { ...args, restarted: r.enrolled });
      return r.enrolled ? 'restarted' : 'notified';
    }
    return 'none';
  } catch (err) {
    console.error('[journeys] lost-lead revive failed:', err instanceof Error ? err.message : err);
    return 'none';
  }
}
