// ============================================================
// Live system facts for the AI agent.
//
// The business prompt is static; this adds what is true right now, read
// fresh for every reply: today's date/time (IST), the upcoming webinar
// schedule (incl. cancellations), and — for the customer being answered —
// their booked session, journey stage, tags, caller, payment status and
// callback request. Best effort: any failure just leaves a section out.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

const TZ = 'Asia/Kolkata';
const fmtDateTime = (d: Date) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(d) + ' IST';

const placeholder = (v: unknown) => typeof v !== 'string' || !v.trim() || /PASTE/i.test(v);

/** Journey "Settings" variables (webinar_link, payment_link, …) from the account's live journeys. */
async function journeyVars(db: SupabaseClient, accountId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const { data } = await db.from('journeys').select('graph').eq('account_id', accountId).eq('status', 'active');
  for (const j of data ?? []) {
    for (const n of ((j.graph as { nodes?: { type: string; config?: { assignments?: { key?: string; value?: unknown }[] } }[] } | null)?.nodes ?? [])) {
      if (n.type !== 'set_variable') continue;
      for (const a of n.config?.assignments ?? []) if (a.key && !placeholder(a.value) && !(a.key in out)) out[a.key] = String(a.value);
    }
  }
  return out;
}

async function scheduleSection(db: SupabaseClient, accountId: string, now: Date, mainLink: string | null): Promise<string | null> {
  const { data, error } = await db
    .from('webinar_sessions')
    .select('starts_at, link, status')
    .eq('account_id', accountId)
    .gte('starts_at', now.toISOString())
    .lte('starts_at', new Date(now.getTime() + 14 * 864e5).toISOString())
    .order('starts_at')
    .limit(20);
  if (error || !data?.length) return null;
  const upcoming = data.filter((s) => s.status === 'scheduled').slice(0, 7);
  const cancelled = data.filter((s) => s.status === 'cancelled');
  const lines = upcoming.map((s) => `- ${fmtDateTime(new Date(s.starts_at as string))}${s.link || mainLink ? ` — join link: ${s.link || mainLink}` : ''}`);
  const out = [`Upcoming webinar sessions (the official schedule):\n${lines.join('\n') || '- none scheduled yet'}`];
  if (cancelled.length) out.push(`Cancelled sessions (do NOT offer these): ${cancelled.map((s) => fmtDateTime(new Date(s.starts_at as string))).join('; ')}`);
  return out.join('\n');
}

const STAGE_HINTS: [RegExp, string][] = [
  [/^(wait_msg|t2_|t1_|tag_registered|wait_checkin|schedule|is_moved|t6_|clear_moved)/, 'registered, waiting for their webinar session'],
  [/^(reply_menu|menu|t3_|mark_menu|revive)/, 'webinar done — was sent the post-webinar check-in menu'],
  [/^(pay_|reply_pay|tag_paylink)/, 'got the payment link, deciding'],
  [/^(faq|reply_faq)/, 'reading the FAQ'],
  [/^(cb_|callback)/, 'asked for / waiting for a callback'],
  [/^a_/, 'follow-up messages (did not reply yet)'],
  [/^b_/, 'follow-up messages (replied before)'],
  [/^c_/, 'follow-up messages (cold lead)'],
  [/^d_/, 'follow-up after the payment link (testimonials)'],
];

/** The customer's own open callback request (not the team's "new lead to call" task). */
async function openCallback(
  db: SupabaseClient,
  contactId: string
): Promise<{ data: { status: string; priority: string; requested_at: string; scheduled_for?: string | null } | null }> {
  const q = (cols: string) =>
    db
      .from('callback_requests')
      .select(cols)
      .eq('contact_id', contactId)
      .neq('status', 'done')
      .or('source_kind.is.null,source_kind.neq.engagement')
      .limit(1)
      .maybeSingle();
  const first = await q('status, priority, requested_at, scheduled_for');
  const data = first.error ? (await q('status, priority, requested_at')).data : first.data;
  return { data: data as unknown as { status: string; priority: string; requested_at: string; scheduled_for?: string | null } | null };
}

async function leadSection(db: SupabaseClient, accountId: string, contactId: string, now: Date): Promise<string | null> {
  const [{ data: contact }, { data: tagRows }, { data: runs }, { data: cb }] = await Promise.all([
    db.from('contacts').select('name, phone, created_at, assigned_caller_id').eq('id', contactId).eq('account_id', accountId).maybeSingle(),
    db.from('contact_tags').select('tags(name)').eq('contact_id', contactId),
    db
      .from('journey_enrollments')
      .select('status, current_node_id, context, entered_at')
      .eq('contact_id', contactId)
      .in('status', ['active', 'waiting'])
      .order('entered_at', { ascending: false })
      .limit(1),
    // Only requests the customer made (not the team's own "new lead to call" task).
    openCallback(db, contactId),
  ]);
  if (!contact) return null;

  const tags = (tagRows ?? [])
    .map((t) => ((Array.isArray(t.tags) ? t.tags[0] : t.tags) as { name?: string } | null)?.name)
    .filter(Boolean) as string[];
  const lines: string[] = [`- Name: ${contact.name || 'unknown'}`, `- Registered / first contact: ${fmtDateTime(new Date(contact.created_at as string))}`];
  if (tags.length) lines.push(`- Tags: ${tags.join(', ')}`);

  if (contact.assigned_caller_id) {
    const { data: p } = await db.from('profiles').select('full_name').eq('user_id', contact.assigned_caller_id).maybeSingle();
    if (p?.full_name) lines.push(`- Their caller (team member): ${p.full_name}`);
  }

  const run = runs?.[0];
  const ctx = (run?.context ?? {}) as { nodes?: { schedule?: { start_iso?: string; link?: string } }; vars?: Record<string, unknown> };
  const s = ctx.nodes?.schedule;
  if (s?.start_iso) {
    const start = new Date(s.start_iso);
    const when = start.getTime() > now.getTime() ? 'upcoming' : 'already took place';
    lines.push(`- Their booked webinar session: ${fmtDateTime(start)} (${when})${s.link && !placeholder(s.link) ? ` — join link: ${s.link}` : ''}`);
  }
  if (run?.current_node_id) {
    const hint = STAGE_HINTS.find(([re]) => re.test(String(run.current_node_id)))?.[1];
    if (hint) lines.push(`- Where they are: ${hint}`);
  }

  const has = (t: string) => tags.some((x) => x.toLowerCase() === t);
  // One clear status the reply playbook (defaults.ts) keys off. Amounts are
  // never given to the AI (pricing rule) — only whether a balance is open.
  const [{ count: fullyPaid }, { count: claimed }] = await Promise.all([
    db.from('payment_records').select('id', { count: 'exact', head: true }).eq('contact_id', contactId),
    db
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', contactId)
      .eq('type', 'payment_click')
      .like('title', 'Says they paid%')
      .gte('created_at', new Date(now.getTime() - 7 * 864e5).toISOString()),
  ]);
  let status: string;
  if (has('unsubscribe')) status = 'OPTED OUT — they sent STOP; answer only what they ask, never promote.';
  else if (has('paid') || (fullyPaid ?? 0) > 0) status = 'CUSTOMER — paid in full, enrolled in the program.';
  else if (has('customer')) status = 'CUSTOMER — paid an advance; the remaining balance is handled by their caller.';
  else if ((claimed ?? 0) > 0) status = 'SAID THEY PAID — the team is verifying the payment (not confirmed yet).';
  else if (has('manually_closed')) status = 'CLOSED — said they are not proceeding (can still come back).';
  else if (has('closed_lost')) status = 'LOST — went quiet through all follow-ups (can still come back).';
  else if (run) status = 'ACTIVE LEAD — in the webinar journey (see "Where they are").';
  else status = 'NOT IN THE JOURNEY — no active webinar booking.';
  lines.unshift(`- LEAD STATUS: ${status}`);
  if (!has('paid') && !has('customer') && has('payment_link_sent')) lines.push('- Payment: payment link already sent, not paid yet.');
  if (cb) {
    const at = cb.scheduled_for ? ` They asked to be called at ${fmtDateTime(new Date(cb.scheduled_for))} — this time is saved and their caller will call then.` : ' The team will call them.';
    lines.push(`- Callback: requested a call ${fmtDateTime(new Date(cb.requested_at))} — status "${cb.status}"${cb.priority === 'high' ? ', priority' : ''}.${at}`);
  }

  return `About this customer (live from the system):\n${lines.join('\n')}`;
}

/** The live-facts block for the AI system prompt (empty string if nothing to add). */
export async function buildLiveContext(db: SupabaseClient, accountId: string, contactId: string | null, now = new Date()): Promise<string> {
  const parts = [`Current date and time: ${fmtDateTime(now)}`];
  try {
    const vars = await journeyVars(db, accountId);
    const mainLink = vars.webinar_link ?? null;
    const sched = await scheduleSection(db, accountId, now, mainLink).catch(() => null);
    if (sched) parts.push(sched);
    const links: string[] = [];
    if (mainLink) links.push(`- Main webinar join link: ${mainLink}`);
    if (vars.payment_link) links.push(`- Payment link (to join the program): ${vars.payment_link}`);
    if (links.length) parts.push(`Official links:\n${links.join('\n')}`);
    if (contactId) {
      const lead = await leadSection(db, accountId, contactId, now).catch(() => null);
      if (lead) parts.push(lead);
    }
  } catch (err) {
    console.warn('[ai live-context] failed:', err instanceof Error ? err.message : err);
  }
  return parts.join('\n\n');
}
