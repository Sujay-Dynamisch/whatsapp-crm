import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'acct', userId: 'agent-1' }),
  toErrorResponse: (e: unknown) => {
    throw e;
  },
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => 'admin-db' }));
vi.mock('@/lib/journeys/dispatch', () => ({ liveJourneyDeps: { live: true } }));
const svc = vi.hoisted(() => ({
  actOnFailed: vi.fn(async (_db: unknown, args: { keys: string[] }) => args.keys.map((key) => ({ key, ok: key.startsWith('journey') }))),
}));
vi.mock('@/lib/failed-messages/service', () => svc);

const { POST } = await import('./route');
const K1 = 'journey:3f1c2b9e-7a44-4d0e-9a51-2c6b8d0e1f23';
const K2 = 'inbox:3f1c2b9e-7a44-4d0e-9a51-2c6b8d0e1f24';
const post = (body: unknown) => POST(new Request('https://x', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  svc.actOnFailed.mockClear();
});

describe('POST /api/failed-messages/actions', () => {
  it('runs the action for the account and reports per message', async () => {
    const res = await post({ keys: [K1, K2, 'junk', 42], action: 'resend' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: 1, failed: 1 });
    expect(svc.actOnFailed).toHaveBeenCalledWith('admin-db', expect.objectContaining({ accountId: 'acct', userId: 'agent-1', keys: [K1, K2], action: 'resend' }), { live: true });
  });

  it('validates keys, action and text', async () => {
    expect((await post({ keys: [], action: 'resend' })).status).toBe(400);
    expect((await post({ keys: [K1], action: 'explode' })).status).toBe(400);
    expect((await post({ keys: [K1], action: 'send_text', text: '  ' })).status).toBe(400);
    expect((await post({ keys: Array.from({ length: 201 }, () => K1), action: 'dismiss' })).status).toBe(400);
    expect(svc.actOnFailed).not.toHaveBeenCalled();
  });

  it('passes schedule time and text through', async () => {
    await post({ keys: [K1], action: 'schedule', at: '2026-11-05T05:30:00Z' });
    await post({ keys: [K1], action: 'send_text', text: 'Hi' });
    const calls = svc.actOnFailed.mock.calls as unknown as [unknown, { action: string; at?: string; text?: string }][];
    expect(calls.map((c) => [c[1].action, c[1].at, c[1].text])).toEqual([
      ['schedule', '2026-11-05T05:30:00Z', undefined],
      ['send_text', undefined, 'Hi'],
    ]);
  });
});
