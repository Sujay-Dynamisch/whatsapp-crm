import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- in-memory callback_requests behind the caller's (RLS) client ----
const ACCOUNT = 'acct';
const ID = '3f1c2b9e-7a44-4d0e-9a51-2c6b8d0e1f23';
type Row = Record<string, unknown>;
let rows: Row[] = [];

function client() {
  return {
    from: (table: string) => {
      const preds: ((r: Row) => boolean)[] = [];
      let patch: Row | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        update: (p: Row) => ((patch = p), b),
        delete: () => b,
        ilike: () => b,
        limit: () => b,
        eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), b),
        maybeSingle: async () => {
          if (table !== 'callback_requests') return { data: null, error: null };
          const row = rows.find((r) => preds.every((p) => p(r)));
          if (row && patch) Object.assign(row, patch);
          return { data: row ? { ...row } : null, error: null };
        },
      };
      return b;
    },
  };
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ supabase: client(), accountId: ACCOUNT, userId: 'agent-1' }),
  toErrorResponse: (e: unknown) => {
    throw e;
  },
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => 'admin-db' }));
vi.mock('@/lib/journeys/dispatch', () => ({ liveJourneyDeps: {} }));
const followups = vi.hoisted(() => ({
  handleNoAnswer: vi.fn(async () => ({ action: 'messaged', count: 1, limit: 2 })),
  returnToNurture: vi.fn(async () => ({ started: true, journeyId: 'j1' })),
}));
vi.mock('@/lib/callbacks/followups', () => followups);

const { PATCH } = await import('./route');
const { POST } = await import('./nurture/route');

const params = { params: Promise.resolve({ id: ID }) };
const patch = (body: unknown) => PATCH(new Request('https://x', { method: 'PATCH', body: JSON.stringify(body) }), params);

beforeEach(() => {
  rows = [{ id: ID, account_id: ACCOUNT, contact_id: 'c1', status: 'new', no_answer_count: 0, note: null, reminded_at: null }];
  followups.handleNoAnswer.mockClear();
  followups.returnToNurture.mockClear();
});

describe('PATCH /api/callbacks/[id] — No answer', () => {
  it('counts every "No answer" and follows up with the lead', async () => {
    const res = await patch({ status: 'no_answer' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ request: { status: 'no_answer', no_answer_count: 1 }, followup: { action: 'messaged' } });
    expect(followups.handleNoAnswer).toHaveBeenCalledWith('admin-db', ID, {});
    await patch({ status: 'no_answer' });
    expect(rows[0].no_answer_count).toBe(2);
  });

  it('a closed request must be re-opened first; re-opening resets the count and reminder', async () => {
    rows[0] = { ...rows[0], status: 'done', no_answer_count: 2, reminded_at: '2026-11-03T00:00:00Z' };
    expect((await patch({ status: 'no_answer' })).status).toBe(409);
    expect(followups.handleNoAnswer).not.toHaveBeenCalled();
    await patch({ status: 'new' });
    expect(rows[0]).toMatchObject({ status: 'new', no_answer_count: 0, reminded_at: null });
  });

  it('other statuses do not follow up', async () => {
    const res = await patch({ status: 'called' });
    expect((await res.json()).followup).toBeNull();
    expect(followups.handleNoAnswer).not.toHaveBeenCalled();
  });

  it('the status change stands even if the follow-up throws', async () => {
    followups.handleNoAnswer.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await patch({ status: 'no_answer' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ request: { status: 'no_answer' }, followup: null });
  });
});

describe('POST /api/callbacks/[id]/nurture', () => {
  it('puts the lead back into nurture', async () => {
    const res = await POST(new Request('https://x', { method: 'POST' }), params);
    expect(res.status).toBe(200);
    expect(followups.returnToNurture).toHaveBeenCalledWith('admin-db', expect.objectContaining({ id: ID }), {}, 'manual');
  });

  it('explains why it could not (409)', async () => {
    followups.returnToNurture.mockResolvedValueOnce({ started: false, reason: 'opted_out' } as never);
    const res = await POST(new Request('https://x', { method: 'POST' }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'opted_out' });
  });

  it('404s another account’s / unknown request and 409s a closed one', async () => {
    rows[0].account_id = 'other';
    expect((await POST(new Request('https://x'), params)).status).toBe(404);
    rows[0] = { ...rows[0], account_id: ACCOUNT, status: 'done' };
    expect((await POST(new Request('https://x'), params)).status).toBe(409);
    expect(followups.returnToNurture).not.toHaveBeenCalled();
  });
});
