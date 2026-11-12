// ============================================================
// GET  /api/callers   members + caller settings + workload, and the
//                     Admin Unassigned queue (migration 086)
// POST /api/callers   { userId }  make a team member a caller
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { isAccountMember, requireCallersAccess } from '@/lib/callers/server';

export async function GET() {
  try {
    const { admin, accountId } = await requireCallersAccess('view');

    const [{ data: members }, { data: callers }, { data: openCb }, { data: owned }, { data: openEng }] = await Promise.all([
      admin.from('profiles').select('user_id, full_name, email, account_role').eq('account_id', accountId),
      admin.from('callers').select('user_id, status, lead_eligible, created_at').eq('account_id', accountId),
      admin
        .from('callback_requests')
        .select('contact_id, assigned_caller_id, priority, requested_at')
        .eq('account_id', accountId)
        .neq('status', 'done')
        .limit(10000),
      admin.from('contacts').select('assigned_caller_id').eq('account_id', accountId).not('assigned_caller_id', 'is', null).limit(50000),
      admin
        .from('engagements')
        .select('contact_id, accepted_at')
        .eq('account_id', accountId)
        .eq('status', 'open')
        .is('assigned_caller_id', null)
        .limit(1000),
    ]);

    const leads = new Map<string, number>();
    for (const c of owned ?? []) leads.set(c.assigned_caller_id as string, (leads.get(c.assigned_caller_id as string) ?? 0) + 1);
    const cbs = new Map<string, { open: number; priority: number }>();
    for (const r of openCb ?? []) {
      if (!r.assigned_caller_id) continue;
      const k = r.assigned_caller_id as string;
      const v = cbs.get(k) ?? { open: 0, priority: 0 };
      v.open++;
      if (r.priority === 'high') v.priority++;
      cbs.set(k, v);
    }
    const callerBy = new Map((callers ?? []).map((c) => [c.user_id as string, c]));

    // Admin Unassigned: open engagements / open callbacks with no caller.
    const unassigned = new Map<string, { contact_id: string; since: string; priority: boolean }>();
    for (const e of openEng ?? []) {
      unassigned.set(e.contact_id as string, { contact_id: e.contact_id as string, since: e.accepted_at as string, priority: false });
    }
    for (const r of openCb ?? []) {
      if (r.assigned_caller_id) continue;
      const cur = unassigned.get(r.contact_id as string);
      unassigned.set(r.contact_id as string, {
        contact_id: r.contact_id as string,
        since: cur?.since ?? (r.requested_at as string),
        priority: (cur?.priority ?? false) || r.priority === 'high',
      });
    }
    const ids = [...unassigned.keys()].slice(0, 500);
    const { data: contacts } = ids.length
      ? await admin.from('contacts').select('id, name, phone').in('id', ids)
      : { data: [] as { id: string; name: string | null; phone: string }[] };
    const contactBy = new Map((contacts ?? []).map((c) => [c.id as string, c]));

    return NextResponse.json({
      members: (members ?? []).map((m) => {
        const c = callerBy.get(m.user_id as string);
        return {
          user_id: m.user_id,
          full_name: m.full_name,
          email: m.email,
          account_role: m.account_role,
          caller: c ? { status: c.status, lead_eligible: c.lead_eligible, since: c.created_at } : null,
          open_leads: leads.get(m.user_id as string) ?? 0,
          open_callbacks: cbs.get(m.user_id as string)?.open ?? 0,
          priority_callbacks: cbs.get(m.user_id as string)?.priority ?? 0,
        };
      }),
      unassigned: ids
        .map((id) => {
          const u = unassigned.get(id)!;
          const c = contactBy.get(id);
          return { ...u, name: c?.name ?? null, phone: c?.phone ?? null };
        })
        .sort((a, b) => Number(b.priority) - Number(a.priority) || Date.parse(b.since) - Date.parse(a.since)),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { admin, accountId } = await requireCallersAccess('edit');
    const body = (await request.json().catch(() => ({}))) as { userId?: string };
    if (!body.userId || !(await isAccountMember(admin, accountId, body.userId))) {
      return NextResponse.json({ error: 'Not a member of this account' }, { status: 400 });
    }
    const { error } = await admin
      .from('callers')
      .upsert({ account_id: accountId, user_id: body.userId }, { onConflict: 'account_id,user_id', ignoreDuplicates: true });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
