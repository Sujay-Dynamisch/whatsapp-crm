// ============================================================
// PATCH /api/callbacks/[id]   { status?, note? }   (migration 058)
// Work a callback request: Called / No answer / Done (+ a short note).
// Done also removes the contact's `callback_requested` tag, so a later
// request opens a fresh one. Agents and up.
// "No answer" (migration 059) counts the attempt and follows up: the lead
// gets "we tried calling you", or at the limit goes back to nurture
// (src/lib/callbacks/followups.ts). Re-opening resets the count.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { UUID_RE } from '@/lib/journeys/api';
import { handleNoAnswer } from '@/lib/callbacks/followups';
import { accountPaymentLink, generalTemplateApproved, logCallbackEvent } from '@/lib/callbacks/timeline';
import { TrashError, trashCallback } from '@/lib/trash/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { liveJourneyDeps } from '@/lib/journeys/dispatch';

const STATUSES = ['new', 'called', 'no_answer', 'done'] as const;

/** DELETE /api/callbacks/[id] — admins only; moves the request to the trash (100). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    try {
      await trashCallback(supabaseAdmin(), { accountId, userId, id });
    } catch (err) {
      if (err instanceof TrashError) return NextResponse.json({ error: err.message }, { status: err.status });
      throw err;
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

interface TimelineItem {
  at: string;
  kind: 'requested' | 'status' | 'note' | 'payment_link';
  value: string | null;
  detail: string | null;
  actor: string | null;
}

/**
 * GET /api/callbacks/[id] — full details for the card's side panel: the
 * lead, their tags, every callback request they made, and one timeline
 * (requests, status changes, notes, payment links), newest first.
 * Reads run with the viewer's RLS, so callers see only their own leads.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const cols = 'id, contact_id, conversation_id, status, source, requested_at, handled_at, handled_by, no_answer_count, priority, source_kind, assigned_caller_id, ai_meta';
    const one = (c: string) => supabase.from('callback_requests').select(c).eq('id', id).eq('account_id', accountId).maybeSingle();
    type ReqRow = {
      id: string;
      contact_id: string;
      conversation_id: string | null;
      status: string;
      assigned_caller_id: string | null;
      scheduled_for?: string | null;
      [k: string]: unknown;
    };
    const first = await one(`${cols}, scheduled_for`);
    const req = (first.error ? (await one(cols)).data : first.data) as unknown as ReqRow | null;
    if (!req) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    const contactId = req.contact_id as string;

    const [{ data: contact }, { data: tagRows }, { data: requests }, { data: events }, { data: conv }] = await Promise.all([
      supabase.from('contacts').select('name, phone, email, created_at, assigned_caller_id').eq('id', contactId).maybeSingle(),
      supabase.from('contact_tags').select('tags(name, color)').eq('contact_id', contactId),
      supabase
        .from('callback_requests')
        .select('id, status, source, requested_at, handled_at, handled_by')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('requested_at', { ascending: false })
        .limit(50),
      supabase.from('callback_events').select('callback_id, kind, value, detail, actor_id, created_at').eq('contact_id', contactId).order('created_at', { ascending: false }).limit(300),
      req.conversation_id
        ? supabase.from('conversations').select('last_customer_message_at').eq('id', req.conversation_id as string).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const people = [
      ...new Set(
        [req.assigned_caller_id, contact?.assigned_caller_id, ...(events ?? []).map((e) => e.actor_id), ...(requests ?? []).map((r) => r.handled_by)].filter(Boolean) as string[]
      ),
    ];
    const { data: profs } = people.length ? await supabase.from('profiles').select('user_id, full_name').in('user_id', people) : { data: [] };
    const nameOf = (uid: unknown) => (uid ? ((profs ?? []).find((p) => p.user_id === uid)?.full_name as string) || 'Team member' : null);

    const timeline: TimelineItem[] = [];
    const withEvents = new Set((events ?? []).filter((e) => e.kind === 'status').map((e) => e.callback_id as string));
    for (const r of requests ?? []) {
      timeline.push({ at: r.requested_at as string, kind: 'requested', value: null, detail: (r.source as string) ?? null, actor: null });
      // Requests handled before the timeline existed: show the last change.
      if (!withEvents.has(r.id as string) && r.handled_at && r.status !== 'new') {
        timeline.push({ at: r.handled_at as string, kind: 'status', value: r.status as string, detail: null, actor: nameOf(r.handled_by) });
      }
    }
    for (const e of events ?? []) {
      timeline.push({ at: e.created_at as string, kind: e.kind as TimelineItem['kind'], value: (e.value as string) ?? null, detail: (e.detail as string) ?? null, actor: nameOf(e.actor_id) });
    }
    timeline.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

    const admin = supabaseAdmin();
    const lastIn = Date.parse(String((conv as { last_customer_message_at?: string } | null)?.last_customer_message_at ?? ''));
    const [link, templateOk] = await Promise.all([accountPaymentLink(admin, accountId), generalTemplateApproved(admin, accountId)]);

    return NextResponse.json({
      request: { ...req, caller_name: nameOf(req.assigned_caller_id) },
      contact: contact ? { ...contact, owner_name: nameOf(contact.assigned_caller_id) } : null,
      tags: (tagRows ?? [])
        .map((t) => (Array.isArray(t.tags) ? t.tags[0] : t.tags) as { name: string; color: string } | null)
        .filter(Boolean),
      requests: (requests ?? []).length,
      timeline,
      paymentLink: {
        available: !!link,
        windowOpen: Number.isFinite(lastIn) && Date.now() - lastIn < 24 * 3600_000,
        templateOk,
        sentCount: timeline.filter((t) => t.kind === 'payment_link').length,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId, userId, role } = await requireRole('agent');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as { status?: string; note?: string; priority?: string };

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status as (typeof STATUSES)[number])) {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
      }
      update.status = body.status;
      update.handled_by = body.status === 'new' ? null : userId;
      update.handled_at = body.status === 'new' ? null : new Date().toISOString();
      if (body.status === 'new') {
        update.no_answer_count = 0;
        update.reminded_at = null;
      }
      if (body.status === 'no_answer') {
        const { data: current } = await supabase
          .from('callback_requests')
          .select('no_answer_count, status')
          .eq('id', id)
          .eq('account_id', accountId)
          .maybeSingle();
        if (!current) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
        if (current.status === 'done') {
          return NextResponse.json({ error: 'This request is closed — re-open it first' }, { status: 409 });
        }
        update.no_answer_count = (Number(current.no_answer_count) || 0) + 1;
      }
    }
    if (body.note !== undefined) {
      update.note = String(body.note).trim().slice(0, 500) || null;
      // Author + time shown to owners/admins on the Callbacks page (089).
      update.note_by = update.note ? userId : null;
      update.note_at = update.note ? new Date().toISOString() : null;
    }
    // Manual Priority toggle from the card — any agent can flag a lead as
    // urgent (independent of the auto-detected 'high' from the customer's
    // own "call me" request, 086/101). Taking it back off manually is an
    // admin/owner call only — a caller who no longer thinks it's urgent
    // asks an admin, rather than quietly dropping someone else's flag.
    // (The automatic reset below, once the request is actually attended
    // to, is unaffected and open to everyone.)
    if (body.priority !== undefined) {
      if (!['normal', 'high'].includes(body.priority)) {
        return NextResponse.json({ error: 'Invalid priority' }, { status: 400 });
      }
      if (body.priority === 'normal' && !hasMinRole(role, 'admin')) {
        return NextResponse.json({ error: 'Only an admin or owner can remove Priority' }, { status: 403 });
      }
      update.priority = body.priority;
    }
    // The caller attended to it (Called / Done / wrote a note): it leaves the
    // Priority queue regardless of the above. A fresh ask from the customer
    // re-flags it (086/101).
    if (body.status === 'called' || body.status === 'done' || update.note) {
      update.priority = 'normal';
    }

    const { data: row, error } = await supabase
      .from('callback_requests')
      .update(update)
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id, contact_id, status, note, priority, handled_at, handled_by, no_answer_count')
      .maybeSingle();
    if (error) {
      // Re-opening while the contact already has another open request.
      if (error.code === '23505') {
        return NextResponse.json({ error: 'This contact already has an open callback request' }, { status: 409 });
      }
      throw error;
    }
    if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

    // Timeline (099): every status change and every note is kept.
    const log = { accountId, callbackId: row.id as string, contactId: row.contact_id as string, actorId: userId };
    if (body.status !== undefined) await logCallbackEvent(supabaseAdmin(), { ...log, kind: 'status', value: body.status });
    if (body.note !== undefined && update.note) await logCallbackEvent(supabaseAdmin(), { ...log, kind: 'note', detail: update.note as string });

    if (row.status === 'done') {
      const { data: tag } = await supabase
        .from('tags')
        .select('id')
        .eq('account_id', accountId)
        .ilike('name', 'callback_requested')
        .limit(1)
        .maybeSingle();
      // Service role: the caller's RLS (custom roles without contacts edit)
      // can silently block this, leaving the tag so later taps never re-open.
      if (tag) await supabaseAdmin().from('contact_tags').delete().eq('contact_id', row.contact_id).eq('tag_id', tag.id);
    }
    // Follow up with the lead (message / back to nurture). Best effort:
    // the status change above stands either way.
    const followup =
      body.status === 'no_answer'
        ? await handleNoAnswer(supabaseAdmin(), row.id, liveJourneyDeps).catch((err) => {
            console.error('[callbacks] no-answer follow-up failed:', err instanceof Error ? err.message : err);
            return null;
          })
        : null;
    return NextResponse.json({ request: row, followup });
  } catch (error) {
    return toErrorResponse(error);
  }
}
