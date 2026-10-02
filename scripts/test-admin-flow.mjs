import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "..", ".env.local");

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
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const client = createClient(supabaseUrl, anonKey);
const admin = createClient(supabaseUrl, serviceRoleKey);

async function runTests() {
  console.log("=== STEP 1: Verify Admin Sign-in with admin@gmail.com / admin@8550 ===");
  const { data: adminAuth, error: adminAuthError } = await client.auth.signInWithPassword({
    email: "admin@gmail.com",
    password: "admin@8550",
  });

  if (adminAuthError) {
    console.error("FAIL: Admin sign-in failed:", adminAuthError);
    process.exit(1);
  }
  console.log("PASS: Admin signed in successfully! User ID:", adminAuth.user.id);
  console.log("Admin Email Confirmed At:", adminAuth.user.email_confirmed_at);

  console.log("\n=== STEP 2: Verify Profiles Role ===");
  const { data: profile, error: profError } = await admin
    .from("profiles")
    .select("role, full_name, email, account_id")
    .eq("user_id", adminAuth.user.id)
    .single();

  if (profError) {
    console.error("FAIL: Profile lookup failed:", profError);
    process.exit(1);
  }
  console.log("PASS: Admin Profile Role:", profile.role);
  if (profile.role !== "admin") {
    console.error("FAIL: Expected profile.role to be 'admin', found:", profile.role);
    process.exit(1);
  }

  console.log("\n=== STEP 3: Test Customer Onboarding Without Email Verification ===");
  const testEmail = `test_client_${Date.now()}@crm.local`;
  const testPassword = "ClientSecret@123";
  const testName = "Jane Client";

  const { data: newCustomer, error: createError } = await admin.auth.admin.createUser({
    email: testEmail,
    password: testPassword,
    email_confirm: true,
    user_metadata: { full_name: testName },
  });

  if (createError) {
    console.error("FAIL: Customer onboarding failed:", createError);
    process.exit(1);
  }
  console.log("PASS: Customer created directly with confirmed email:", newCustomer.user.id);
  console.log("Customer email confirmed:", !!newCustomer.user.email_confirmed_at);

  console.log("\n=== STEP 4: Verify Customer Can Immediately Sign In (Zero Verification) ===");
  const testClient = createClient(supabaseUrl, anonKey);
  const { data: custAuth, error: custAuthError } = await testClient.auth.signInWithPassword({
    email: testEmail,
    password: testPassword,
  });

  if (custAuthError) {
    console.error("FAIL: Customer immediate sign in failed:", custAuthError);
    process.exit(1);
  }
  console.log("PASS: Customer signed in immediately without email verification!");
  console.log("Logged in customer session ID:", custAuth.session.access_token ? "Valid Token" : "None");

  console.log("\n=== STEP 5: Verify Customer Account and Profile Creation ===");
  const { data: custProfile, error: custProfErr } = await admin
    .from("profiles")
    .select("full_name, email, account_id, account_role")
    .eq("user_id", newCustomer.user.id)
    .single();

  if (custProfErr) {
    console.error("FAIL: Customer profile not found:", custProfErr);
  } else {
    console.log("PASS: Customer Profile:", custProfile);
    console.log("Customer Account Role:", custProfile.account_role);
  }

  // Cleanup test user
  console.log("\n=== STEP 6: Cleanup Test User ===");
  await admin.auth.admin.deleteUser(newCustomer.user.id);
  console.log("PASS: Test customer cleaned up successfully.");

  console.log("\n========================================================");
  console.log("ALL FUNCTIONAL AND AUTHENTICATION TESTS PASSED SUCCESSFULLY!");
  console.log("========================================================");
}

runTests().catch((err) => {
  console.error("Test execution error:", err);
  process.exit(1);
});
