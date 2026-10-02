import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isSystemAdmin } from "@/lib/auth/admin";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user: currentUser },
    } = await supabase.auth.getUser();

    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify system admin authorization
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
    const { fullName, companyName, emailOrUsername, password } = body;

    if (!fullName || typeof fullName !== "string" || !fullName.trim()) {
      return NextResponse.json(
        { error: "Customer full name is required." },
        { status: 400 }
      );
    }

    if (!emailOrUsername || typeof emailOrUsername !== "string" || !emailOrUsername.trim()) {
      return NextResponse.json(
        { error: "Email or custom username is required." },
        { status: 400 }
      );
    }

    if (!password || typeof password !== "string" || password.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters long." },
        { status: 400 }
      );
    }

    // Normalize email/username into valid email format for Supabase Auth
    let normalizedEmail = emailOrUsername.trim().toLowerCase();
    if (!normalizedEmail.includes("@")) {
      // Username provided: convert to standard platform email representation
      normalizedEmail = `${normalizedEmail.replace(/[^a-z0-9._-]/g, "")}@crm.local`;
    }

    const admin = getSupabaseAdmin();

    // Create user with email pre-confirmed (no email verification needed!)
    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email: normalizedEmail,
        password: password,
        email_confirm: true,
        user_metadata: {
          full_name: fullName.trim(),
        },
      });

    if (createError) {
      return NextResponse.json(
        { error: createError.message },
        { status: 400 }
      );
    }

    const newUserId = created.user.id;
    const finalCompanyName =
      companyName && companyName.trim() ? companyName.trim() : `${fullName.trim()}'s Workspace`;

    // Wait slightly or update the created account name if custom company name provided
    try {
      await admin
        .from("accounts")
        .update({ name: finalCompanyName })
        .eq("owner_user_id", newUserId);
    } catch {
      // Non-fatal if account bootstrap trigger handles default naming
    }

    return NextResponse.json({
      success: true,
      user: {
        id: newUserId,
        fullName: fullName.trim(),
        email: normalizedEmail,
        companyName: finalCompanyName,
        emailConfirmed: true,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
