// Server-side guard for system-admin API routes. Same rule as the
// existing admin routes (isSystemAdmin on the caller's email/profile
// role) — profiles.role is now writable only by the service role
// (migration 045), so a user can no longer grant it to themselves.

import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';
import { isSystemAdmin } from '@/lib/auth/admin';

export type SystemAdminResult =
  | { ok: true; user: User }
  | { ok: false; response: NextResponse };

export async function requireSystemAdmin(): Promise<SystemAdminResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!isSystemAdmin(user.email, profile?.role)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Forbidden: System Admin privileges required.' },
        { status: 403 }
      ),
    };
  }
  return { ok: true, user };
}
