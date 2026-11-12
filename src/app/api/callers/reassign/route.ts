// ============================================================
// POST /api/callers/reassign  { contactId, toCallerId | null }
// Manual reassignment (migration 086): audited, the new caller is
// notified, the round-robin cursor is never touched.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { UUID_RE } from '@/lib/journeys/api';
import { reassignContact, requireCallersAccess } from '@/lib/callers/server';

export async function POST(request: Request) {
  try {
    const { admin, accountId, userId } = await requireCallersAccess('edit');
    const body = (await request.json().catch(() => ({}))) as { contactId?: string; toCallerId?: string | null };
    if (!body.contactId || !UUID_RE.test(body.contactId)) return NextResponse.json({ error: 'Invalid contact' }, { status: 400 });
    const to = body.toCallerId ?? null;
    if (to) {
      const { data: caller } = await admin
        .from('callers')
        .select('status')
        .eq('account_id', accountId)
        .eq('user_id', to)
        .maybeSingle();
      if (!caller || caller.status !== 'active') {
        return NextResponse.json({ error: 'Pick an active caller' }, { status: 400 });
      }
    }
    await reassignContact(admin, { accountId, contactId: body.contactId, toCallerId: to, actorId: userId, reason: 'MANUAL_REASSIGNMENT' });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
