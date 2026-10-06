// ============================================================
// /api/admin/accounts/[id]/features   (migration 045)
//
//   GET  { accountId, name, disabled_features, features: [{ key, label,
//          description, enabled }] }
//   PUT  { disabled_features: Feature[] } → same shape
//
// System admin only. Writes go through the service-role client —
// accounts.disabled_features rejects every other writer.
// ============================================================

import { NextResponse } from 'next/server';

import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { requireSystemAdmin } from '@/lib/auth/system-admin-guard';
import {
  FEATURE_INFO,
  FEATURES,
  isFeatureEnabled,
  parseDisabledFeatures,
} from '@/lib/features';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteParams {
  params: Promise<{ id: string }>;
}

function describe(account: { id: string; name: string; disabled_features: string[] | null }) {
  const disabled = account.disabled_features ?? [];
  return {
    accountId: account.id,
    name: account.name,
    disabled_features: disabled,
    features: FEATURES.map((key) => ({
      key,
      label: FEATURE_INFO[key].label,
      description: FEATURE_INFO[key].description,
      implies: FEATURE_INFO[key].implies ?? [],
      // Explicitly switched off, vs. off because a parent feature is.
      switchedOff: disabled.includes(key),
      enabled: isFeatureEnabled(disabled, key),
    })),
  };
}

export async function GET(_request: Request, { params }: RouteParams) {
  const guard = await requireSystemAdmin();
  if (!guard.ok) return guard.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid account id' }, { status: 400 });
  }

  const { data, error } = await getSupabaseAdmin()
    .from('accounts')
    .select('id, name, disabled_features')
    .eq('id', id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  return NextResponse.json(describe(data));
}

export async function PUT(request: Request, { params }: RouteParams) {
  const guard = await requireSystemAdmin();
  if (!guard.ok) return guard.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid account id' }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const parsed = parseDisabledFeatures(body?.disabled_features);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { data, error } = await getSupabaseAdmin()
    .from('accounts')
    .update({ disabled_features: parsed.value })
    .eq('id', id)
    .select('id, name, disabled_features')
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  console.log(
    JSON.stringify({
      audit: 'account_features_updated',
      by: guard.user.email,
      accountId: id,
      disabled_features: parsed.value,
    })
  );
  return NextResponse.json(describe(data));
}
