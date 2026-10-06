import { beforeEach, describe, expect, it, vi } from 'vitest';

let user: { id: string; email: string } | null = null;
let profileRole: string | null = null;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: () => {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: profileRole ? { role: profileRole } : null }),
      };
      return b;
    },
  }),
}));

const { requireSystemAdmin } = await import('./system-admin-guard');

beforeEach(() => {
  user = null;
  profileRole = null;
});

describe('requireSystemAdmin', () => {
  it('401s without a session', async () => {
    const r = await requireSystemAdmin();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it('403s an ordinary customer (account owner/admin roles do not count)', async () => {
    user = { id: 'u1', email: 'owner@acme.com' };
    profileRole = 'user';
    const r = await requireSystemAdmin();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it('allows the system admin email', async () => {
    user = { id: 'u1', email: 'Admin@Gmail.com' };
    const r = await requireSystemAdmin();
    expect(r.ok).toBe(true);
  });

  it('allows a profile with the system admin role', async () => {
    user = { id: 'u2', email: 'ops@platform.com' };
    profileRole = 'superadmin';
    const r = await requireSystemAdmin();
    expect(r.ok).toBe(true);
  });
});
