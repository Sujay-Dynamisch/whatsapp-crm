import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  authError: null as Error | null,
  rpcArgs: null as Record<string, string> | null,
  rpcError: null as { message: string } | null,
  recentFilters: {} as Record<string, unknown>,
}));

vi.mock('@/lib/auth/account', async () => {
  const { NextResponse } = await import('next/server');
  return {
    getCurrentAccount: async () => {
      if (state.authError) throw state.authError;
      return {
        accountId: 'acct-1',
        supabase: {
          rpc: async (_fn: string, args: Record<string, string>) => {
            state.rpcArgs = args;
            return state.rpcError
              ? { data: null, error: state.rpcError }
              : { data: { totals: { clicks: 3 } }, error: null };
          },
          from: () => {
            const b = {
              select: () => b,
              eq: (c: string, v: unknown) => ((state.recentFilters[c] = v), b),
              gte: (c: string, v: unknown) => ((state.recentFilters[`${c}>=`] = v), b),
              order: () => b,
              limit: () => b,
              then: (r: (v: unknown) => unknown) =>
                Promise.resolve({ data: [{ id: 'click-1' }], error: null }).then(r),
            };
            return b;
          },
        },
      };
    },
    toErrorResponse: (err: Error) => NextResponse.json({ error: err.message }, { status: 401 }),
  };
});

const { GET } = await import('./route');
const get = (qs = '') => GET(new Request(`https://app.test/api/button-clicks${qs}`));

beforeEach(() => {
  state.authError = null;
  state.rpcArgs = null;
  state.rpcError = null;
  state.recentFilters = {};
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/button-clicks', () => {
  it('returns the summary and recent clicks for the caller’s account', async () => {
    const res = await get('?days=7');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      days: 7,
      summary: { totals: { clicks: 3 } },
      recent: [{ id: 'click-1' }],
    });
    expect(state.recentFilters.account_id).toBe('acct-1');
    const from = new Date(state.rpcArgs!.p_from).getTime();
    const to = new Date(state.rpcArgs!.p_to).getTime();
    expect(Math.round((to - from) / 86_400_000)).toBe(7);
  });

  it('falls back to 30 days for unsupported ranges', async () => {
    expect((await (await get('?days=5000')).json()).days).toBe(30);
    expect((await (await get()).json()).days).toBe(30);
  });

  it('filters recent clicks by broadcast and validates the id', async () => {
    const id = '3f1c2b9e-7a44-4d0e-9a51-2c6b8d0e1f23';
    await get(`?broadcast_id=${id}`);
    expect(state.recentFilters.broadcast_id).toBe(id);
    expect((await get('?broadcast_id=nope')).status).toBe(400);
  });

  it('500s without leaking database errors', async () => {
    state.rpcError = { message: 'relation button_clicks does not exist' };
    const res = await get();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to load button clicks');
  });

  it('maps auth failures through toErrorResponse', async () => {
    state.authError = new Error('Unauthorized');
    expect((await get()).status).toBe(401);
  });
});
