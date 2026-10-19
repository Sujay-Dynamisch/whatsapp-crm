import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isSystemAdmin, SYSTEM_ADMIN_EMAIL } from "@/lib/auth/admin";
import { isAccountRole } from "@/lib/auth/roles";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: targetUserId } = await params;
    const supabase = await createClient();
    const {
      data: { user: currentUser },
    } = await supabase.auth.getUser();

    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("user_id", currentUser.id)
      .maybeSingle();

    if (!isSystemAdmin(currentUser.email, profile?.role)) {
      return NextResponse.json(
        { error: "Forbidden: System Admin privileges required." },
        { status: 403 }
      );
    }

    const admin = getSupabaseAdmin();

    // 1. Fetch user from Supabase Auth
    const {
      data: { user: targetUser },
      error: userError,
    } = await admin.auth.admin.getUserById(targetUserId);

    if (userError || !targetUser) {
      return NextResponse.json(
        { error: userError?.message || "User not found" },
        { status: 404 }
      );
    }

    // 2. Fetch profile from database
    const { data: targetProfile } = await admin
      .from("profiles")
      .select("*")
      .eq("user_id", targetUserId)
      .maybeSingle();

    // 3. Fetch account and analytics
    let targetAccount = null;
    let teamMembers: Array<{
      id: string;
      user_id: string;
      full_name: string;
      email: string;
      account_role: string;
      role: string;
      created_at: string;
      avatar_url?: string | null;
    }> = [];
    let waConfig = null;
    let stats = {
      contactsCount: 0,
      conversationsCount: 0,
      broadcastsCount: 0,
      teamMembersCount: 1,
    };

    if (targetProfile?.account_id) {
      const { data: acc } = await admin
        .from("accounts")
        .select("*")
        .eq("id", targetProfile.account_id)
        .maybeSingle();
      targetAccount = acc;

      const [contactsRes, convsRes, broadcastsRes, membersRes, waRes] = await Promise.all([
        admin
          .from("contacts")
          .select("*", { count: "exact", head: true })
          .eq("account_id", targetProfile.account_id),
        admin
          .from("conversations")
          .select("*", { count: "exact", head: true })
          .eq("account_id", targetProfile.account_id),
        admin
          .from("broadcasts")
          .select("*", { count: "exact", head: true })
          .eq("account_id", targetProfile.account_id),
        admin
          .from("profiles")
          .select("id, user_id, full_name, email, account_role, role, created_at, avatar_url")
          .eq("account_id", targetProfile.account_id),
        admin
          .from("whatsapp_config")
          .select("id, phone_number_id, waba_id, status, connected_at, created_at")
          .eq("account_id", targetProfile.account_id)
          .maybeSingle(),
      ]);

      stats = {
        contactsCount: contactsRes.count ?? 0,
        conversationsCount: convsRes.count ?? 0,
        broadcastsCount: broadcastsRes.count ?? 0,
        teamMembersCount: membersRes.data?.length ?? 1,
      };

      teamMembers = membersRes.data ?? [];
      waConfig = waRes.data ?? null;
    }

    const isBanned = Boolean(
      targetUser.banned_until && new Date(targetUser.banned_until) > new Date()
    );

    return NextResponse.json({
      user: {
        id: targetUser.id,
        email: targetUser.email || "N/A",
        fullName:
          targetProfile?.full_name ||
          (targetUser.user_metadata?.full_name as string) ||
          "",
        avatarUrl: targetProfile?.avatar_url || null,
        accountRole: targetProfile?.account_role || "owner",
        systemRole: targetProfile?.role || "user",
        emailConfirmed: Boolean(targetUser.email_confirmed_at),
        emailConfirmedAt: targetUser.email_confirmed_at || null,
        createdAt: targetUser.created_at,
        lastSignInAt: targetUser.last_sign_in_at || null,
        bannedUntil: targetUser.banned_until || null,
        isBanned,
        phone: targetUser.phone || null,
        phoneConfirmedAt: targetUser.phone_confirmed_at || null,
        userMetadata: targetUser.user_metadata || {},
        appMetadata: targetUser.app_metadata || {},
      },
      account: targetAccount
        ? {
            id: targetAccount.id,
            name: targetAccount.name,
            ownerUserId: targetAccount.owner_user_id,
            createdAt: targetAccount.created_at,
            disabledFeatures: targetAccount.disabled_features || [],
          }
        : null,
      stats,
      whatsapp: waConfig,
      teamMembers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id: targetUserId } = await params;
    const supabase = await createClient();
    const {
      data: { user: currentUser },
    } = await supabase.auth.getUser();

    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("user_id", currentUser.id)
      .maybeSingle();

    if (!isSystemAdmin(currentUser.email, profile?.role)) {
      return NextResponse.json(
        { error: "Forbidden: System Admin privileges required." },
        { status: 403 }
      );
    }

    const body = await request.json();
    const {
      password,
      fullName,
      accountRole,
      systemRole,
      accountName,
      emailConfirm,
      isBanned,
      disabledFeatures,
    } = body;

    const admin = getSupabaseAdmin();
    const authUpdatePayload: Record<string, unknown> = {};

    // 1. Password update
    if (password !== undefined) {
      if (typeof password !== "string" || password.length < 6) {
        return NextResponse.json(
          { error: "Password must be at least 6 characters long." },
          { status: 400 }
        );
      }
      authUpdatePayload.password = password;
      authUpdatePayload.email_confirm = true;
    }

    // 2. Email verification
    if (emailConfirm === true) {
      authUpdatePayload.email_confirm = true;
    }

    // 3. Ban status
    if (typeof isBanned === "boolean") {
      const {
        data: { user: targetUser },
      } = await admin.auth.admin.getUserById(targetUserId);

      if (
        targetUser?.email?.toLowerCase() === SYSTEM_ADMIN_EMAIL.toLowerCase() ||
        targetUserId === currentUser.id
      ) {
        return NextResponse.json(
          { error: "Cannot suspend or ban the system administrator." },
          { status: 400 }
        );
      }
      authUpdatePayload.ban_duration = isBanned ? "876000h" : "none";
    }

    // 4. Full Name update
    if (fullName !== undefined) {
      const trimmed = String(fullName).trim();
      authUpdatePayload.user_metadata = { full_name: trimmed };
      await admin
        .from("profiles")
        .update({ full_name: trimmed })
        .eq("user_id", targetUserId);
    }

    // 5. Apply auth updates
    if (Object.keys(authUpdatePayload).length > 0) {
      const { error: authErr } = await admin.auth.admin.updateUserById(
        targetUserId,
        authUpdatePayload
      );
      if (authErr) {
        return NextResponse.json({ error: authErr.message }, { status: 400 });
      }
    }

    // 6. Account role & system role in profiles
    const profileUpdates: Record<string, unknown> = {};
    if (accountRole !== undefined) {
      if (!isAccountRole(accountRole)) {
        return NextResponse.json(
          { error: `Invalid account role: ${accountRole}` },
          { status: 400 }
        );
      }
      profileUpdates.account_role = accountRole;
    }

    if (systemRole !== undefined) {
      if (systemRole !== "admin" && systemRole !== "user") {
        return NextResponse.json(
          { error: `Invalid system role: ${systemRole}` },
          { status: 400 }
        );
      }
      profileUpdates.role = systemRole;
    }

    if (Object.keys(profileUpdates).length > 0) {
      const { error: profErr } = await admin
        .from("profiles")
        .update(profileUpdates)
        .eq("user_id", targetUserId);

      if (profErr) {
        return NextResponse.json({ error: profErr.message }, { status: 400 });
      }
    }

    // 7. Account updates (account name, disabled features)
    if (accountName !== undefined || disabledFeatures !== undefined) {
      const { data: prof } = await admin
        .from("profiles")
        .select("account_id")
        .eq("user_id", targetUserId)
        .maybeSingle();

      if (prof?.account_id) {
        const accUpdates: Record<string, unknown> = {};
        if (accountName !== undefined) {
          accUpdates.name = String(accountName).trim();
        }
        if (disabledFeatures !== undefined && Array.isArray(disabledFeatures)) {
          accUpdates.disabled_features = disabledFeatures;
        }

        if (Object.keys(accUpdates).length > 0) {
          const { error: accErr } = await admin
            .from("accounts")
            .update(accUpdates)
            .eq("id", prof.account_id);

          if (accErr) {
            return NextResponse.json({ error: accErr.message }, { status: 400 });
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: "User and account updated successfully.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id: targetUserId } = await params;
    const supabase = await createClient();
    const {
      data: { user: currentUser },
    } = await supabase.auth.getUser();

    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("user_id", currentUser.id)
      .maybeSingle();

    if (!isSystemAdmin(currentUser.email, profile?.role)) {
      return NextResponse.json(
        { error: "Forbidden: System Admin privileges required." },
        { status: 403 }
      );
    }

    // Protect the primary system admin from being deleted
    const admin = getSupabaseAdmin();
    const {
      data: { user: targetUser },
    } = await admin.auth.admin.getUserById(targetUserId);

    if (
      targetUser?.email?.toLowerCase() === SYSTEM_ADMIN_EMAIL.toLowerCase() ||
      targetUserId === currentUser.id
    ) {
      return NextResponse.json(
        { error: "Cannot delete the primary system administrator account." },
        { status: 400 }
      );
    }

    // 1. Delete all accounts owned by this user (cascades to contacts, conversations, pipelines, etc.)
    await admin.from("accounts").delete().eq("owner_user_id", targetUserId);

    // 2. Delete the user profile if still remaining
    await admin.from("profiles").delete().eq("user_id", targetUserId);

    // 3. Delete presence if present
    await admin.from("member_presence").delete().eq("user_id", targetUserId);

    // 4. Delete from Supabase Auth
    const { error: deleteError } = await admin.auth.admin.deleteUser(targetUserId);

    if (deleteError) {
      const errText =
        deleteError.message ||
        (typeof deleteError === "object"
          ? JSON.stringify(deleteError)
          : String(deleteError));
      return NextResponse.json({ error: errText }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      message: "User deleted successfully.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
