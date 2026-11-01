// ============================================================
// PATCH  /api/account/roles/[id]  { name?, description?, base_role?, permissions? }
// DELETE /api/account/roles/[id]
// (migration 062) Admin+ with Edit on "Team & roles". Changing the base
// role moves its members with it (trigger). A role still used by members
// or pending invites can't be deleted — reassign them first (deleting
// would silently lift their restrictions).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { parseRoleInput, type RoleInput } from '@/lib/auth/custom-roles';
import { UUID_RE } from '@/lib/journeys/api';

const COLUMNS = 'id, name, description, base_role, permissions, created_at, updated_at';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const { data: current } = await supabase.from('account_custom_roles').select(COLUMNS).eq('id', id).eq('account_id', accountId).maybeSingle();
    if (!current) return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    const parsed = parseRoleInput(await request.json().catch(() => null), current as unknown as RoleInput);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { data, error } = await supabase
      .from('account_custom_roles')
      .update({ ...parsed.value, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', accountId)
      .select(COLUMNS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'A role with this name already exists' }, { status: 409 });
      throw error;
    }
    if (!data) return NextResponse.json({ error: 'You can’t manage roles' }, { status: 403 });
    return NextResponse.json({ role: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const [{ count: members }, { count: invites }] = await Promise.all([
      supabase.from('profiles').select('user_id', { count: 'exact', head: true }).eq('account_id', accountId).eq('custom_role_id', id),
      supabase
        .from('account_invitations')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('custom_role_id', id)
        .is('accepted_at', null)
        .gt('expires_at', new Date().toISOString()),
    ]);
    if ((members ?? 0) > 0 || (invites ?? 0) > 0) {
      return NextResponse.json(
        { error: `This role is still used by ${members ?? 0} member(s) and ${invites ?? 0} pending invite(s) — give them another role first`, members, invites },
        { status: 409 }
      );
    }
    const { data, error } = await supabase.from('account_custom_roles').delete().eq('id', id).eq('account_id', accountId).select('id');
    if (error) {
      if (error.code === '23503') return NextResponse.json({ error: 'This role is still in use — give its members another role first' }, { status: 409 });
      throw error;
    }
    if (!data?.length) return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
