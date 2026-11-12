// ============================================================
// GET /api/failed-messages/registrations?status=open|all
// Website registrations the lead sync skipped (invalid phone number).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { isScopedCaller } from '@/lib/callers/scope';

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    // Skipped registrations belong to no caller yet — admins only (086).
    if (await isScopedCaller(supabase)) return NextResponse.json({ registrations: [] });
    const all = new URL(request.url).searchParams.get('status') === 'all';
    let q = supabase
      .from('lead_sync_issues')
      .select('id, registration_id, kind, raw_phone, name, email, city, registered_at, created_at, resolved, resolved_at, contact_id')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(300);
    if (!all) q = q.is('resolved', null);
    const { data, error } = await q;
    if (error) throw error;
    return NextResponse.json({ registrations: data ?? [] });
  } catch (error) {
    return toErrorResponse(error);
  }
}
