// ============================================================
// Server-side feature checks for code that runs without a user
// request (webhook dispatch, Cloud Functions, cron engines). These
// use the service-role client, which bypasses RLS — so the restrictive
// policies from migration 045 don't apply, and the check is made here.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isFeatureEnabled, type Feature } from './features';

export async function loadDisabledFeatures(
  db: SupabaseClient,
  accountId: string
): Promise<string[]> {
  const { data, error } = await db
    .from('accounts')
    .select('disabled_features')
    .eq('id', accountId)
    .maybeSingle();
  if (error) {
    // Column missing (migration 045 not applied yet) → behave as
    // before the feature existed: everything on.
    if (/disabled_features/.test(error.message)) return [];
    throw new Error(`Failed to load account features: ${error.message}`);
  }
  return (data?.disabled_features as string[] | null) ?? [];
}

export async function accountHasFeature(
  db: SupabaseClient,
  accountId: string,
  feature: Feature
): Promise<boolean> {
  return isFeatureEnabled(await loadDisabledFeatures(db, accountId), feature);
}
