import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ---- auth knob ----------------------------------------------------
let guardResult:
  | { ok: true; user: { email: string } }
  | { ok: false; response: NextResponse } = { ok: true, user: { email: 'admin@gmail.com' } };

vi.mock('@/lib/auth/system-admin-guard', () => ({
  requireSystemAdmin: async () => guardResult,
}));

// ---- service-role client: one in-memory accounts table -------------
const ACCOUNT = '3f1c2b9e-7a44-4d0e-9a51-2c6b8d0e1f23';
let accounts: { id: string; name: string; disabled_features: string[] }[] = [];
const updates: unknown[] = [];

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      let id: string | null = null;
      let patch: Record<string, unknown> | null = null;
      const b = {
        select: () => b,
        update: (p: Record<string, unknown>) => ((patch = p), updates.push(p), b),
        eq: (_c: string, v: string) => ((id = v), b),
        maybeSingle: async () => {
          const row = accounts.find((a) => a.id === id);
          if (row && patch) Object.assign(row, patch);
          return { data: row ? { ...row } : null, error: null };
        },
      };
      return b;
    },
  }),
}));

const { GET, PUT } = await import('./route');

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const put = (body: unknown) =>
  new Request(`https://app.test/api/admin/accounts/${ACCOUNT}/features`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

beforeEach(() => {
  guardResult = { ok: true, user: { email: 'admin@gmail.com' } };
  accounts = [{ id: ACCOUNT, name: 'Acme', disabled_features: [] }];
  updates.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('authorization', () => {
  it('passes through the guard’s 401 / 403 and never touches the database', async () => {
    guardResult = {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
    expect((await GET(new Request('https://x'), params(ACCOUNT))).status).toBe(403);
    expect((await PUT(put({ disabled_features: ['flows'] }), params(ACCOUNT))).status).toBe(403);
    expect(updates).toHaveLength(0);
    expect(accounts[0].disabled_features).toEqual([]);

    guardResult = {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
    expect((await GET(new Request('https://x'), params(ACCOUNT))).status).toBe(401);
  });
});

describe('GET', () => {
  it('lists every feature with its effective state', async () => {
    accounts[0].disabled_features = ['broadcasts'];
    const res = await GET(new Request('https://x'), params(ACCOUNT));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accountId).toBe(ACCOUNT);
    expect(body.name).toBe('Acme');
    const byKey = Object.fromEntries(
      body.features.map((f: { key: string }) => [f.key, f])
    );
    expect(byKey.broadcasts).toMatchObject({ enabled: false, switchedOff: true });
    // Off because its parent is off, not switched off itself.
    expect(byKey.broadcast_scheduling).toMatchObject({ enabled: false, switchedOff: false });
    expect(byKey.pipelines).toMatchObject({ enabled: true, switchedOff: false });
    expect(body.features).toHaveLength(9);
  });

  it('400s a malformed id and 404s an unknown account', async () => {
    expect((await GET(new Request('https://x'), params('not-a-uuid'))).status).toBe(400);
    expect(
      (await GET(new Request('https://x'), params('00000000-0000-0000-0000-000000000000'))).status
    ).toBe(404);
  });
});

describe('PUT', () => {
  it('saves a normalised list and returns the new state', async () => {
    const res = await PUT(
      put({ disabled_features: ['flows', 'pipelines', 'flows'] }),
      params(ACCOUNT)
    );
    expect(res.status).toBe(200);
    expect(updates).toEqual([{ disabled_features: ['pipelines', 'flows'] }]);
    expect(accounts[0].disabled_features).toEqual(['pipelines', 'flows']);
    const body = await res.json();
    expect(body.disabled_features).toEqual(['pipelines', 'flows']);
  });

  it('re-enables everything with an empty list', async () => {
    accounts[0].disabled_features = ['pipelines', 'ai_agents'];
    const res = await PUT(put({ disabled_features: [] }), params(ACCOUNT));
    expect(res.status).toBe(200);
    expect(accounts[0].disabled_features).toEqual([]);
  });

  it('rejects unknown keys, non-arrays and bad bodies without writing', async () => {
    for (const body of [
      { disabled_features: ['inbox'] },
      { disabled_features: 'flows' },
      {},
      null,
    ]) {
      expect((await PUT(put(body), params(ACCOUNT))).status).toBe(400);
    }
    expect(updates).toHaveLength(0);
  });

  it('400s a malformed id and 404s an unknown account', async () => {
    expect((await PUT(put({ disabled_features: [] }), params('x'))).status).toBe(400);
    expect(
      (await PUT(put({ disabled_features: [] }), params('00000000-0000-0000-0000-000000000000')))
        .status
    ).toBe(404);
  });

  it('writes an audit line naming the admin', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await PUT(put({ disabled_features: ['flows'] }), params(ACCOUNT));
    const line = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(line).toMatchObject({
      audit: 'account_features_updated',
      by: 'admin@gmail.com',
      accountId: ACCOUNT,
      disabled_features: ['flows'],
    });
  });
});
