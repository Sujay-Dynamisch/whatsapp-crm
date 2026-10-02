import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isSystemAdmin } from "@/lib/auth/admin";

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check system admin permission
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!isSystemAdmin(user.email, profile?.role)) {
      return NextResponse.json(
        { error: "Forbidden: System Admin privileges required." },
        { status: 403 }
      );
    }

    const admin = getSupabaseAdmin();

    // 1. Fetch all auth users
    const {
      data: { users: authUsers },
      error: authError,
    } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });

    if (authError) {
      return NextResponse.json({ error: authError.message }, { status: 500 });
    }

    // 2. Fetch profiles
    const { data: profiles, error: profilesError } = await admin
      .from("profiles")
      .select("id, user_id, full_name, email, role, account_id, account_role, created_at");

    if (profilesError) {
      return NextResponse.json({ error: profilesError.message }, { status: 500 });
    }

    // 3. Fetch accounts
    const { data: accounts, error: accountsError } = await admin
      .from("accounts")
      .select("id, name, created_at");

    if (accountsError) {
      return NextResponse.json({ error: accountsError.message }, { status: 500 });
    }

    const profilesMap = new Map((profiles || []).map((p) => [p.user_id, p]));
    const accountsMap = new Map((accounts || []).map((a) => [a.id, a]));

    const usersList = authUsers.map((u) => {
      const prof = profilesMap.get(u.id);
      const acc = prof?.account_id ? accountsMap.get(prof.account_id) : null;

      return {
        id: u.id,
        email: u.email || "N/A",
        fullName: prof?.full_name || (u.user_metadata?.full_name as string) || "N/A",
        accountName: acc?.name || "Personal Workspace",
        accountId: prof?.account_id || null,
        accountRole: prof?.account_role || "owner",
        systemRole: prof?.role || "user",
        emailConfirmed: Boolean(u.email_confirmed_at),
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at || null,
      };
    });

    // Sort by createdAt desc
    usersList.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    // Compute stats
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const stats = {
      totalUsers: usersList.length,
      confirmedUsers: usersList.filter((u) => u.emailConfirmed).length,
      totalAccounts: accounts ? accounts.length : 0,
      newThisWeek: usersList.filter(
        (u) => new Date(u.createdAt) >= sevenDaysAgo
      ).length,
    };

    return NextResponse.json({ users: usersList, stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
