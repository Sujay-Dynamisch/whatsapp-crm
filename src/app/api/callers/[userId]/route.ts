// ============================================================
// GET    /api/callers/[userId]   the caller's open leads
// PATCH  /api/callers/[userId]   { status?: 'active'|'inactive', lead_eligible? }
// DELETE /api/callers/[userId]   stop being a caller
//
// Deactivating (or removing) moves the caller's open leads and
// callbacks to Admin Unassigned (history kept). An inactive agent/viewer
// caller is also signed out and can't sign in until re-activated;
// owners/admins are only taken out of the rotation.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { UUID_RE } from '@/lib/journeys/api';
import { releaseCallerWork, requireCallersAccess } from '@/lib/callers/server';

type Params = { params: Promise<{ userId: string }> };

const BAN_FOREVER = '876000h';

async function setLogin(admin: Awaited<ReturnType<typeof requireCallersAccess>>['admin'], accountId: string, userId: string, allowed: boolean) {
  const { data: prof } = await admin.from('profiles').select('account_role').eq('account_id', accountId).eq('user_id', userId).maybeSingle();
  if (!prof || prof.account_role === 'owner' || prof.account_role === 'admin') return;
  await admin.auth.admin.updateUserById(userId, { ban_duration: allowed ? 'none' : BAN_FOREVER });
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const { admin, accountId } = await requireCallersAccess('view');
    const { userId } = await params;
    if (!UUID_RE.test(userId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const { data } = await admin
      .from('contacts')
      .select('id, name, phone')
      .eq('account_id', accountId)
      .eq('assigned_caller_id', userId)
      .order('updated_at', { ascending: false })
      .limit(500);
    return NextResponse.json({ leads: data ?? [] });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { admin, accountId, userId: actorId } = await requireCallersAccess('edit');
    const { userId } = await params;
    if (!UUID_RE.test(userId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as { status?: string; lead_eligible?: boolean };

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'inactive') {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
      }
      update.status = body.status;
    }
    if (typeof body.lead_eligible === 'boolean') update.lead_eligible = body.lead_eligible;

    const { data: row, error } = await admin
      .from('callers')
      .update(update)
      .eq('account_id', accountId)
      .eq('user_id', userId)
      .select('user_id, status, lead_eligible')
      .maybeSingle();
    if (error) throw error;
    if (!row) return NextResponse.json({ error: 'Caller not found' }, { status: 404 });

    let released = 0;
    if (body.status === 'inactive') {
      if (userId === actorId) return NextResponse.json({ error: "You can't deactivate yourself" }, { status: 400 });
      released = await releaseCallerWork(admin, accountId, userId, actorId);
      await setLogin(admin, accountId, userId, false);
    } else if (body.status === 'active') {
      await setLogin(admin, accountId, userId, true);
    }
    return NextResponse.json({ caller: row, released });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { admin, accountId, userId: actorId } = await requireCallersAccess('edit');
    const { userId } = await params;
    if (!UUID_RE.test(userId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const { data: row } = await admin.from('callers').select('status').eq('account_id', accountId).eq('user_id', userId).maybeSingle();
    if (!row) return NextResponse.json({ error: 'Caller not found' }, { status: 404 });
    const released = await releaseCallerWork(admin, accountId, userId, actorId);
    await admin.from('callers').delete().eq('account_id', accountId).eq('user_id', userId);
    if (row.status === 'inactive') await setLogin(admin, accountId, userId, true);
    return NextResponse.json({ ok: true, released });
  } catch (error) {
    return toErrorResponse(error);
  }
}
