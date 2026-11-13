// ============================================================
// Super admin: move a user into another workspace (migration 091).
//   GET  /api/admin/users/[id]/move   workspaces + their custom roles
//   POST /api/admin/users/[id]/move   { accountId, role, customRoleId? }
//
// For people who signed up into their own workspace by mistake (e.g. an
// invite link that was already used). Their empty sign-up workspace is
// removed; a workspace with data or other members is never touched.
// ============================================================

import { NextResponse } from "next/server";

import { isSystemAdmin } from "@/lib/auth/admin";
import { isAccountRole } from "@/lib/auth/roles";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type RouteParams = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireSystemAdmin(): Promise<NextResponse | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("user_id", user.id).maybeSingle();
  if (!isSystemAdmin(user.email, profile?.role)) {
    return NextResponse.json({ error: "Forbidden: System Admin privileges required." }, { status: 403 });
  }
  return null;
}

export async function GET() {
  const denied = await requireSystemAdmin();
  if (denied) return denied;
  const admin = getSupabaseAdmin();
  const [{ data: accounts, error }, { data: roles }] = await Promise.all([
    admin.from("accounts").select("id, name").order("name"),
    admin.from("account_custom_roles").select("id, account_id, name, base_role").order("name"),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    accounts: (accounts ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      roles: (roles ?? []).filter((r) => r.account_id === a.id).map((r) => ({ id: r.id, name: r.name, base_role: r.base_role })),
    })),
  });
}

export async function POST(request: Request, { params }: RouteParams) {
  const denied = await requireSystemAdmin();
  if (denied) return denied;
  const { id: userId } = await params;
  const body = (await request.json().catch(() => ({}))) as { accountId?: string; role?: string; customRoleId?: string | null };
  if (!UUID_RE.test(userId) || !body.accountId || !UUID_RE.test(body.accountId)) {
    return NextResponse.json({ error: "Choose a workspace" }, { status: 400 });
  }
  if (!isAccountRole(body.role) || body.role === "owner") {
    return NextResponse.json({ error: "Choose a role (admin, agent or viewer)" }, { status: 400 });
  }
  const customRoleId = body.customRoleId && UUID_RE.test(body.customRoleId) ? body.customRoleId : null;

  const { error } = await getSupabaseAdmin().rpc("admin_move_user_to_account", {
    p_user_id: userId,
    p_account_id: body.accountId,
    p_role: body.role,
    p_custom_role_id: customRoleId,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
