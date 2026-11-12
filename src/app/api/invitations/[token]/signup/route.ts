// ============================================================
// POST /api/invitations/[token]/signup  { fullName, email, password }
//
// Create an account for someone joining through a VALID invite link —
// already email-confirmed, so they can sign in at once (no "check your
// email" step). Public sign-ups (no invite) still confirm by email.
//
// The invite token is the proof: it must be valid (not expired, revoked
// or used). Rate-limited per IP. The member still clicks "Accept" on
// /join/<token>, which redeems the invite into the account.
// ============================================================

import { NextResponse } from "next/server";

import { hashInviteToken } from "@/lib/auth/invitations";
import { checkRateLimit, getClientIp, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { createClient } from "@/lib/supabase/server";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const limit = checkRateLimit(`invite-signup:${getClientIp(request)}`, RATE_LIMITS.invitationRedeem);
  if (!limit.success) return rateLimitResponse(limit);

  const { token } = await params;
  const body = (await request.json().catch(() => ({}))) as { fullName?: unknown; email?: unknown; password?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const fullName = typeof body.fullName === "string" ? body.fullName.trim().slice(0, 120) : "";
  if (!token || !EMAIL_RE.test(email)) return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  if (password.length < 6) return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
  if (!fullName) return NextResponse.json({ error: "Enter your name" }, { status: 400 });

  // Same check as /peek (anonymous RPC), then create with the service role.
  const { data: invite, error: peekErr } = await (await createClient()).rpc("peek_invitation", { p_token_hash: hashInviteToken(token) });
  if (peekErr) {
    console.error("[invite-signup] peek failed:", peekErr.message);
    return NextResponse.json({ error: "Could not check the invite" }, { status: 500 });
  }
  if (!(invite as { ok?: boolean } | null)?.ok) {
    return NextResponse.json({ error: "This invite link is no longer valid. Ask for a new one." }, { status: 410 });
  }

  const { error } = await supabaseAdmin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error) {
    if (/already|registered|exists/i.test(error.message)) {
      return NextResponse.json({ error: "This email already has an account — sign in instead.", code: "exists" }, { status: 409 });
    }
    console.error("[invite-signup] createUser failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
