// ============================================================
// Caller data scope for routes that read/write through the service role
// (which bypasses RLS). A "scoped caller" (086: a non-admin caller in a
// caller-managed account) may only touch their own customers — the same
// rule the database enforces for direct reads.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/** True when the signed-in user (RLS client) is a scoped caller. */
export async function isScopedCaller(supabase: SupabaseClient | null | undefined): Promise<boolean> {
  if (!supabase?.rpc) return false;
  const { data, error } = await supabase.rpc('my_caller_restricted');
  return !error && data === true;
}

/** Which of these contacts the signed-in user can see (RLS client). */
export async function visibleContactIds(supabase: SupabaseClient, ids: (string | null | undefined)[]): Promise<Set<string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Set<string>();
  for (let i = 0; i < want.length; i += 500) {
    const { data } = await supabase.from('contacts').select('id').in('id', want.slice(i, i + 500));
    for (const r of data ?? []) out.add(r.id as string);
  }
  return out;
}
