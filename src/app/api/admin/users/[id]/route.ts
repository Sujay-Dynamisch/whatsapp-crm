import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isSystemAdmin, SYSTEM_ADMIN_EMAIL } from "@/lib/auth/admin";

interface RouteParams {
  params: Promise<{ id: string }>;
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
    const { password, fullName } = body;

    const admin = getSupabaseAdmin();
    const updatePayload: {
      password?: string;
      email_confirm?: boolean;
      user_metadata?: Record<string, unknown>;
    } = {};

    if (password) {
      if (typeof password !== "string" || password.length < 6) {
        return NextResponse.json(
          { error: "Password must be at least 6 characters long." },
          { status: 400 }
        );
      }
      updatePayload.password = password;
      updatePayload.email_confirm = true;
    }

    if (fullName) {
      updatePayload.user_metadata = { full_name: fullName.trim() };
      await admin
        .from("profiles")
        .update({ full_name: fullName.trim() })
        .eq("user_id", targetUserId);
    }

    const { data: updated, error: updateError } =
      await admin.auth.admin.updateUserById(targetUserId, updatePayload);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      message: "User updated successfully.",
      user: updated.user,
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
