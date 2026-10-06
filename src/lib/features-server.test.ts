import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { accountHasFeature, loadDisabledFeatures } from './features-server';

function db(result: { data?: unknown; error?: { message: string } | null }) {
  const calls: Record<string, unknown> = {};
  const client = {
    from(table: string) {
      calls.table = table;
      const b = {
        select: (cols: string) => ((calls.cols = cols), b),
        eq: (c: string, v: unknown) => ((calls[c] = v), b),
        maybeSingle: async () => ({ data: result.data ?? null, error: result.error ?? null }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe('loadDisabledFeatures', () => {
  it('reads the account row', async () => {
    const { client, calls } = db({ data: { disabled_features: ['flows'] } });
    expect(await loadDisabledFeatures(client, 'acct-1')).toEqual(['flows']);
    expect(calls).toMatchObject({ table: 'accounts', cols: 'disabled_features', id: 'acct-1' });
  });

  it('treats a missing account or null column as everything on', async () => {
    expect(await loadDisabledFeatures(db({ data: null }).client, 'a')).toEqual([]);
    expect(await loadDisabledFeatures(db({ data: { disabled_features: null } }).client, 'a')).toEqual([]);
  });

  it('keeps working before migration 045 is applied (column missing)', async () => {
    const { client } = db({
      error: { message: 'column accounts.disabled_features does not exist' },
    });
    expect(await loadDisabledFeatures(client, 'a')).toEqual([]);
  });

  it('throws on any other database error (callers must not guess)', async () => {
    const { client } = db({ error: { message: 'connection reset' } });
    await expect(loadDisabledFeatures(client, 'a')).rejects.toThrow('connection reset');
  });
});

describe('accountHasFeature', () => {
  it('applies the same rules as isFeatureEnabled, including dependants', async () => {
    const { client } = db({ data: { disabled_features: ['broadcasts'] } });
    expect(await accountHasFeature(client, 'a', 'broadcasts')).toBe(false);
    expect(await accountHasFeature(client, 'a', 'broadcast_scheduling')).toBe(false);
    expect(await accountHasFeature(client, 'a', 'pipelines')).toBe(true);
  });
});
