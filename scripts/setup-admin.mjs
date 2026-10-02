import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "..", ".env.local");

// Load .env.local if present
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ADMIN_EMAIL = "admin@gmail.com";
const ADMIN_PASSWORD = "admin@8550";
const ADMIN_FULL_NAME = "System Admin";

async function main() {
  console.log(`Checking admin user: ${ADMIN_EMAIL}...`);

  // List existing users to check if admin@gmail.com is present
  const { data: { users }, error: listError } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (listError) {
    console.error("Failed to list users:", listError);
    process.exit(1);
  }

  const existingAdmin = users.find(
    (u) => u.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase()
  );

  let adminUserId = null;

  if (existingAdmin) {
    console.log(`Found existing user with email ${ADMIN_EMAIL} (${existingAdmin.id}). Updating password and email confirmation...`);
    const { data: updated, error: updateError } = await supabase.auth.admin.updateUserById(
      existingAdmin.id,
      {
        password: ADMIN_PASSWORD,
        email_confirm: true,
        user_metadata: {
          ...existingAdmin.user_metadata,
          full_name: ADMIN_FULL_NAME,
        },
      }
    );

    if (updateError) {
      console.error("Failed to update admin password:", updateError);
      process.exit(1);
    }
    adminUserId = updated.user.id;
    console.log("Successfully updated admin credentials.");
  } else {
    console.log(`User ${ADMIN_EMAIL} not found. Creating new system admin user...`);
    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: ADMIN_FULL_NAME,
      },
    });

    if (createError) {
      console.error("Failed to create admin user:", createError);
      process.exit(1);
    }
    adminUserId = created.user.id;
    console.log(`Successfully created admin user (${adminUserId}).`);
  }

  // Ensure profiles row has role = 'admin'
  console.log("Setting profiles.role to 'admin'...");
  const { error: profileError } = await supabase
    .from("profiles")
    .update({ role: "admin" })
    .eq("user_id", adminUserId);

  if (profileError) {
    console.warn("Notice: could not set profile role:", profileError.message);
  } else {
    console.log("profiles.role set to 'admin'.");
  }

  console.log("\n========================================");
  console.log("Admin setup complete!");
  console.log(`Email:    ${ADMIN_EMAIL}`);
  console.log(`Password: ${ADMIN_PASSWORD}`);
  console.log("Status:   Pre-confirmed (no verification needed)");
  console.log("Role:     System Admin");
  console.log("========================================\n");
}

main().catch((err) => {
  console.error("Setup error:", err);
  process.exit(1);
});
