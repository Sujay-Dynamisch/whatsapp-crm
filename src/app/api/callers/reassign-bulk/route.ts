// ============================================================
// POST /api/callers/reassign-bulk
//   { from: '<callerId>' | 'unassigned', to: '<callerId>' | 'round_robin' | 'unassigned' }
//
// Move every open lead of one caller (or the whole Admin Unassigned
// queue) in one go — e.g. a caller resigned. 'round_robin' shares them
// evenly across active, lead-eligible callers (the source excluded).
// Each move is audited like a manual reassignment; each receiving caller
// gets ONE summary notification instead of one per lead. The rotation
// cursor for new website leads is not touched.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { UUID_RE } from '@/lib/journeys/api';
import { reassignContact, requireCallersAccess } from '@/lib/callers/server';

const MAX = 2000;

export async function POST(request: Request) {
  try {
    const { admin, accountId, userId } = await requireCallersAccess('edit');
    const body = (await request.json().catch(() => ({}))) as { from?: string; to?: string };
    const from = body.from === 'unassigned' ? null : body.from;
    const to = body.to;
    if (from !== null && !(from && UUID_RE.test(from))) return NextResponse.json({ error: 'Choose whose leads to move' }, { status: 400 });
    if (!to || !(to === 'round_robin' || to === 'unassigned' || UUID_RE.test(to))) {
      return NextResponse.json({ error: 'Choose where to move them' }, { status: 400 });
    }

    // Targets: one active caller, or every active lead-eligible caller.
    const { data: callers } = await admin
      .from('callers')
      .select('user_id, status, lead_eligible, created_at')
      .eq('account_id', accountId)
      .eq('status', 'active')
      .order('created_at', { ascending: true });
    let targets: (string | null)[];
    if (to === 'unassigned') targets = [null];
    else if (to === 'round_robin') {
      targets = (callers ?? []).filter((c) => c.lead_eligible && c.user_id !== from).map((c) => c.user_id as string);
      if (!targets.length) return NextResponse.json({ error: 'No other active caller is taking leads' }, { status: 400 });
    } else {
      if (!(callers ?? []).some((c) => c.user_id === to)) return NextResponse.json({ error: 'Pick an active caller' }, { status: 400 });
      if (to === from) return NextResponse.json({ error: 'Pick a different caller' }, { status: 400 });
      targets = [to];
    }

    // The leads to move: contacts owned by the source caller, or (for the
    // unassigned queue) contacts with an open engagement / open callback
    // and no owner.
    let contactIds: string[];
    if (from) {
      const { data } = await admin.from('contacts').select('id').eq('account_id', accountId).eq('assigned_caller_id', from).limit(MAX);
      contactIds = (data ?? []).map((c) => c.id as string);
    } else {
      const [{ data: eng }, { data: cbs }] = await Promise.all([
        admin.from('engagements').select('contact_id').eq('account_id', accountId).eq('status', 'open').is('assigned_caller_id', null).limit(MAX),
        admin.from('callback_requests').select('contact_id').eq('account_id', accountId).neq('status', 'done').is('assigned_caller_id', null).limit(MAX),
      ]);
      contactIds = [...new Set([...(eng ?? []), ...(cbs ?? [])].map((r) => r.contact_id as string))];
    }
    if (!contactIds.length) return NextResponse.json({ moved: 0, perCaller: {} });

    const perCaller: Record<string, number> = {};
    let i = 0;
    for (const contactId of contactIds) {
      const toCaller = targets[i++ % targets.length];
      await reassignContact(admin, {
        accountId,
        contactId,
        toCallerId: toCaller,
        actorId: userId,
        reason: to === 'round_robin' ? 'BULK_REASSIGNMENT_ROUND_ROBIN' : 'BULK_REASSIGNMENT',
        notify: false,
      });
      if (toCaller) perCaller[toCaller] = (perCaller[toCaller] ?? 0) + 1;
    }

    // One notification per receiving caller.
    const rows = Object.entries(perCaller).map(([callerId, n]) => ({
      account_id: accountId,
      user_id: callerId,
      type: 'callback_assigned',
      title: `${n} lead${n === 1 ? '' : 's'} assigned to you`,
      body: 'Open Callbacks to see your new leads.',
    }));
    if (rows.length) await admin.from('notifications').insert(rows);

    return NextResponse.json({ moved: contactIds.length, perCaller });
  } catch (error) {
    return toErrorResponse(error);
  }
}
