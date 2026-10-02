import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { SYSTEM_ADMIN_EMAIL } from "@/lib/auth/admin";

const ADMIN_PASSWORD = "admin@8550";
const ADMIN_FULL_NAME = "System Admin";

export async function POST() {
  try {
    const supabase = getSupabaseAdmin();

    const {
      data: { users },
      error: listError,
    } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });

    if (listError) {
      return NextResponse.json({ error: listError.message }, { status: 500 });
    }

    const existingAdmin = users.find(
      (u) => u.email?.toLowerCase() === SYSTEM_ADMIN_EMAIL.toLowerCase()
    );

    let adminUserId = null;

    if (existingAdmin) {
      const { data: updated, error: updateError } =
        await supabase.auth.admin.updateUserById(existingAdmin.id, {
          password: ADMIN_PASSWORD,
          email_confirm: true,
          user_metadata: {
            ...existingAdmin.user_metadata,
            full_name: ADMIN_FULL_NAME,
          },
        });

      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 });
      }
      adminUserId = updated.user.id;
    } else {
      const { data: created, error: createError } =
        await supabase.auth.admin.createUser({
          email: SYSTEM_ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
          email_confirm: true,
          user_metadata: {
            full_name: ADMIN_FULL_NAME,
          },
        });

      if (createError) {
        return NextResponse.json({ error: createError.message }, { status: 500 });
      }
      adminUserId = created.user.id;
    }

    // Ensure profiles row has role = 'admin'
    await supabase
      .from("profiles")
      .update({ role: "admin" })
      .eq("user_id", adminUserId);

    return NextResponse.json({
      success: true,
      message: "Admin account verified and provisioned.",
      email: SYSTEM_ADMIN_EMAIL,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
