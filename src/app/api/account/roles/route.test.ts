import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- a tiny in-memory Supabase behind the caller's (RLS) client --------
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let rpcCalls: { fn: string; args: Row }[];
let rpcError: Record<string, { code: string; message: string } | null>;
let insertError: { code: string; message: string } | null;
let seq = 0;

function client() {
  return {
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      return { data: null, error: rpcError[fn] ?? null };
    },
    from: (table: string) => {
      const rows = (tables[table] ??= []);
      const preds: ((r: Row) => boolean)[] = [];
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let payload: Row = {};
      let head = false;
      let single = false;
      const run = () => {
        if (op === 'insert') {
          if (insertError) return { data: null, error: insertError };
          const row = { id: `00000000-0000-0000-0000-${String(++seq).padStart(12, '0')}`, ...payload };
          rows.push(row);
          return { data: row, error: null };
        }
        const hit = rows.filter((r) => preds.every((p) => p(r)));
        if (op === 'update') {
          hit.forEach((r) => Object.assign(r, payload));
          return { data: single ? (hit[0] ?? null) : hit, error: null };
        }
        if (op === 'delete') {
          tables[table] = rows.filter((r) => !hit.includes(r));
          return { data: hit, error: null };
        }
        if (head) return { data: null, count: hit.length, error: null };
        return { data: single ? (hit[0] ?? null) : hit, error: null };
      };
      const b: Record<string, unknown> = {
        select: (_c?: string, o?: { head?: boolean }) => ((head = Boolean(o?.head)), b),
        insert: (p: Row) => ((op = 'insert'), (payload = p), b),
        update: (p: Row) => ((op = 'update'), (payload = p), b),
        delete: () => ((op = 'delete'), b),
        eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), b),
        is: (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), b),
        gt: (c: string, v: string) => (preds.push((r) => String(r[c]) > v), b),
        not: (c: string, _op: string, v: unknown) => (preds.push((r) => (r[c] ?? null) !== v), b),
        order: () => b,
        single: () => ((single = true), b),
        maybeSingle: () => ((single = true), b),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      };
      return b;
    },
  };
}

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({ supabase: client(), accountId: 'acct', userId: 'admin-1', role: 'admin' }),
  requireRole: async () => ({ supabase: client(), accountId: 'acct', userId: 'admin-1', role: 'admin' }),
  toErrorResponse: (e: unknown) => {
    throw e;
  },
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: () => null, RATE_LIMITS: {} }));

const roles = await import('./route');
const roleById = await import('./[id]/route');
const member = await import('../members/[userId]/route');
const invites = await import('../invitations/route');

const ROLE = '00000000-0000-0000-0000-0000000000aa';
const json = (body: unknown, method = 'POST') => new Request('https://x', { method, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  seq = 0;
  rpcCalls = [];
  rpcError = {};
  insertError = null;
  tables = {
    account_custom_roles: [
      { id: ROLE, account_id: 'acct', name: 'Sales agent', description: null, base_role: 'agent', permissions: { inbox: 'edit' } },
      { id: 'other-role', account_id: 'other', name: 'X', base_role: 'admin', permissions: {} },
    ],
    profiles: [{ user_id: 'u1', account_id: 'acct', custom_role_id: ROLE }],
    account_invitations: [],
  };
});

describe('roles API', () => {
  it('GET lists this account’s roles with how many members / invites use them', async () => {
    tables.account_invitations.push({ account_id: 'acct', custom_role_id: ROLE, accepted_at: null, expires_at: '2999-01-01T00:00:00Z' });
    const body = await (await roles.GET()).json();
    expect(body.available).toBe(true);
    expect(body.roles).toEqual([expect.objectContaining({ id: ROLE, member_count: 1, invite_count: 1 })]);
  });

  it('POST validates, clamps to the base role and saves', async () => {
    expect((await roles.POST(json({ name: '', base_role: 'agent', permissions: { inbox: 'edit' } }))).status).toBe(400);
    const res = await roles.POST(json({ name: 'Support', base_role: 'viewer', permissions: { inbox: 'edit', members: 'edit' } }));
    expect(res.status).toBe(201);
    expect(tables.account_custom_roles.at(-1)).toMatchObject({
      account_id: 'acct',
      name: 'Support',
      base_role: 'viewer',
      created_by: 'admin-1',
      permissions: expect.objectContaining({ inbox: 'view', members: 'view', broadcasts: 'none' }),
    });
  });

  it('POST: duplicate name → 409', async () => {
    insertError = { code: '23505', message: 'duplicate' };
    expect((await roles.POST(json({ name: 'Sales agent', base_role: 'agent', permissions: { inbox: 'edit' } }))).status).toBe(409);
  });

  it('PATCH keeps unsent fields; another account’s role is 404', async () => {
    const res = await roleById.PATCH(json({ base_role: 'viewer' }, 'PATCH'), params(ROLE));
    expect(res.status).toBe(200);
    expect(tables.account_custom_roles[0]).toMatchObject({ name: 'Sales agent', base_role: 'viewer', permissions: expect.objectContaining({ inbox: 'view' }) });
    expect((await roleById.PATCH(json({ name: 'Y' }, 'PATCH'), params('other-role'))).status).toBe(400);
    expect((await roleById.PATCH(json({ name: 'Y' }, 'PATCH'), params('00000000-0000-0000-0000-0000000000bb'))).status).toBe(404);
  });

  it('DELETE is refused while members or pending invites use the role', async () => {
    const res = await roleById.DELETE(new Request('https://x', { method: 'DELETE' }), params(ROLE));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ members: 1, invites: 0 });
    tables.profiles = [];
    expect((await roleById.DELETE(new Request('https://x', { method: 'DELETE' }), params(ROLE))).status).toBe(200);
    expect(tables.account_custom_roles.map((r) => r.id)).toEqual(['other-role']);
  });
});

describe('member role change', () => {
  const patch = (body: unknown) => member.PATCH(json(body, 'PATCH'), { params: Promise.resolve({ userId: 'u2' }) });

  it('custom role → set_member_access with the role id', async () => {
    expect((await patch({ custom_role_id: ROLE })).status).toBe(200);
    expect(rpcCalls).toEqual([{ fn: 'set_member_access', args: { p_user_id: 'u2', p_role: null, p_custom_role_id: ROLE } }]);
    expect((await patch({ custom_role_id: 'nope' })).status).toBe(400);
  });

  it('built-in role → set_member_access (clears a custom role); falls back to set_member_role before 062', async () => {
    await patch({ role: 'viewer' });
    expect(rpcCalls[0]).toEqual({ fn: 'set_member_access', args: { p_user_id: 'u2', p_role: 'viewer', p_custom_role_id: null } });
    rpcCalls = [];
    rpcError.set_member_access = { code: 'PGRST202', message: 'Could not find the function public.set_member_access' };
    expect((await patch({ role: 'agent' })).status).toBe(200);
    expect(rpcCalls.map((c) => c.fn)).toEqual(['set_member_access', 'set_member_role']);
  });

  it('database refusal (e.g. no Team & roles access) → 403', async () => {
    rpcError.set_member_access = { code: '42501', message: 'This action requires the admin role with access to Team & roles' };
    expect((await patch({ custom_role_id: ROLE })).status).toBe(403);
  });
});

describe('invite with a custom role', () => {
  it('stores the role and uses its base role', async () => {
    const res = await invites.POST(json({ custom_role_id: ROLE, expiresInDays: 7 }));
    expect(res.status).toBe(201);
    expect(tables.account_invitations.at(-1)).toMatchObject({ role: 'agent', custom_role_id: ROLE, account_id: 'acct' });
  });

  it('another account’s role is rejected', async () => {
    expect((await invites.POST(json({ custom_role_id: '00000000-0000-0000-0000-0000000000cc' }))).status).toBe(400);
    expect(tables.account_invitations).toEqual([]);
  });
});
