import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `plain:${v}` }));

import { checkQualityGuard, guardActionFor, normalizeRating } from './quality';
import { parseDeliverySettings, DEFAULT_DELIVERY_SETTINGS } from './settings';

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
  const updates: { table: string; patch: Row }[] = [];
  const client = {
    from(table: string) {
      const rows = tables[table] ?? [];
      let patch: Row | null = null;
      const b = {
        select: () => b,
        eq: () => b,
        update: (p: Row) => ((patch = p), updates.push({ table, patch: p }), b),
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (r: (v: unknown) => unknown) => {
          if (patch) Object.assign(rows[0] ?? {}, patch);
          return Promise.resolve({ error: null }).then(r);
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { client, updates };
}

const NOW = new Date('2026-10-11T12:00:00Z');
const fresh = new Date(NOW.getTime() - 5 * 60_000).toISOString();
const stale = new Date(NOW.getTime() - 3 * 3600_000).toISOString();

afterEach(() => vi.unstubAllGlobals());

describe('rating → action', () => {
  it('normalises Meta values', () => {
    expect(normalizeRating('green')).toBe('GREEN');
    expect(normalizeRating('RED')).toBe('RED');
    expect(normalizeRating('NA')).toBe('UNKNOWN');
    expect(normalizeRating(undefined)).toBe('UNKNOWN');
  });

  it('maps ratings to guard actions', () => {
    expect(guardActionFor('GREEN', true)).toBe('allow');
    expect(guardActionFor('UNKNOWN', true)).toBe('allow');
    expect(guardActionFor('YELLOW', true)).toBe('slow');
    expect(guardActionFor('RED', true)).toBe('block');
    expect(guardActionFor('RED', false)).toBe('allow');
  });
});

describe('checkQualityGuard', () => {
  it('uses a fresh cached rating without calling Meta', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { client } = fakeDb({
      accounts: [{ disabled_features: [] }],
      whatsapp_config: [{ quality_rating: 'RED', messaging_limit_tier: 'TIER_1K', quality_checked_at: fresh }],
    });
    const g = await checkQualityGuard(client, 'acct', NOW);
    expect(g).toMatchObject({ action: 'block', rating: 'RED', tier: 'TIER_1K' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes a stale rating from the Graph API and stores it', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ quality_rating: 'YELLOW', messaging_limit_tier: 'TIER_10K' }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const { client, updates } = fakeDb({
      accounts: [{ disabled_features: [] }],
      whatsapp_config: [
        { id: 'cfg', phone_number_id: 'pn-1', access_token: 'enc', quality_rating: 'GREEN', quality_checked_at: stale },
      ],
    });
    const g = await checkQualityGuard(client, 'acct', NOW);
    expect(g).toMatchObject({ action: 'slow', rating: 'YELLOW', tier: 'TIER_10K' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/pn-1?fields=quality_rating,messaging_limit_tier');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer plain:enc');
    expect(updates.find((u) => u.table === 'whatsapp_config')?.patch).toMatchObject({
      quality_rating: 'YELLOW',
      messaging_limit_tier: 'TIER_10K',
    });
  });

  it('falls back to the cached rating when Meta is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = fakeDb({
      accounts: [{ disabled_features: [] }],
      whatsapp_config: [
        { id: 'cfg', phone_number_id: 'pn-1', access_token: 'enc', quality_rating: 'RED', quality_checked_at: stale },
      ],
    });
    expect((await checkQualityGuard(client, 'acct', NOW)).action).toBe('block');
    warn.mockRestore();
  });

  it('always allows when smart sending is switched off', async () => {
    const { client } = fakeDb({
      accounts: [{ disabled_features: ['smart_sending'] }],
      whatsapp_config: [{ quality_rating: 'RED', quality_checked_at: fresh }],
    });
    expect((await checkQualityGuard(client, 'acct', NOW)).action).toBe('allow');
  });

  it('respects the per-account quality_guard switch', async () => {
    const { client } = fakeDb({
      accounts: [{ disabled_features: [] }],
      delivery_settings: [{ quality_guard: false }],
      whatsapp_config: [{ quality_rating: 'RED', quality_checked_at: fresh }],
    });
    expect((await checkQualityGuard(client, 'acct', NOW)).action).toBe('allow');
  });
});

describe('parseDeliverySettings', () => {
  it('fills defaults and accepts valid values', () => {
    expect(parseDeliverySettings({})).toEqual({ ok: true, value: DEFAULT_DELIVERY_SETTINGS });
    expect(parseDeliverySettings({ retry_delay_hours: 48, quality_guard: false })).toEqual({
      ok: true,
      value: { ...DEFAULT_DELIVERY_SETTINGS, retry_delay_hours: 48, quality_guard: false },
    });
  });

  it('rejects out-of-range numbers and non-boolean switches', () => {
    expect(parseDeliverySettings({ retry_delay_hours: 6 }).ok).toBe(false);
    expect(parseDeliverySettings({ rest_days: 0 }).ok).toBe(false);
    expect(parseDeliverySettings({ yellow_pass_size: 5000 }).ok).toBe(false);
    expect(parseDeliverySettings({ auto_retry_limited: 'yes' }).ok).toBe(false);
  });
});
