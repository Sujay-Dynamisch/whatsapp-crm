// ============================================================
// GET  /api/account/roles  — the account's custom roles (+ how many
//                            members / pending invites use each)
// POST /api/account/roles  { name, description?, base_role, permissions }
// (migration 062). Listing: any member. Creating: admin+ with Edit on
// "Team & roles" (middleware + RLS).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { parseRoleInput } from '@/lib/auth/custom-roles';

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('account_custom_roles')
      .select('id, name, description, base_role, permissions, created_at, updated_at')
      .eq('account_id', accountId)
      .order('name');
    if (error) {
      // Before migration 062: no custom roles yet.
      if (/account_custom_roles/.test(error.message)) return NextResponse.json({ roles: [], available: false });
      throw error;
    }
    const [{ data: members }, { data: invites }] = await Promise.all([
      supabase.from('profiles').select('custom_role_id').eq('account_id', accountId).not('custom_role_id', 'is', null),
      supabase
        .from('account_invitations')
        .select('custom_role_id')
        .eq('account_id', accountId)
        .is('accepted_at', null)
        .gt('expires_at', new Date().toISOString())
        .not('custom_role_id', 'is', null),
    ]);
    const count = (rows: { custom_role_id: string | null }[] | null, id: string) => (rows ?? []).filter((r) => r.custom_role_id === id).length;
    return NextResponse.json({
      available: true,
      roles: (data ?? []).map((r) => ({
        ...r,
        member_count: count(members as { custom_role_id: string | null }[] | null, r.id as string),
        invite_count: count(invites as { custom_role_id: string | null }[] | null, r.id as string),
      })),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const parsed = parseRoleInput(await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { data, error } = await supabase
      .from('account_custom_roles')
      .insert({ account_id: accountId, created_by: userId, ...parsed.value })
      .select('id, name, description, base_role, permissions, created_at, updated_at')
      .single();
    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'A role with this name already exists' }, { status: 409 });
      if (error.code === '42501') return NextResponse.json({ error: 'You can’t manage roles' }, { status: 403 });
      throw error;
    }
    return NextResponse.json({ role: { ...data, member_count: 0, invite_count: 0 } }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
