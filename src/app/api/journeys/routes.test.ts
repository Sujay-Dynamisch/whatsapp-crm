import { beforeEach, describe, expect, it, vi } from 'vitest';

import { newNode, starterGraph, type JourneyGraph } from '@/lib/journeys/graph';
import { removeNode } from '@/components/journeys/journey-canvas';

// ---- in-memory journeys table behind the caller's RLS client ---------
const s = vi.hoisted(() => ({
  journey: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  enrolled: [] as string[],
}));

function client() {
  return {
    from(table: string) {
      let patch: Record<string, unknown> | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: () => b,
        limit: () => b,
        update: (p: Record<string, unknown>) => ((patch = p), s.updates.push(p), b),
        maybeSingle: async () => ({ data: table === 'journeys' ? s.journey : null, error: null }),
        single: async () => {
          if (patch && s.journey) Object.assign(s.journey, patch);
          return { data: s.journey, error: null };
        },
        then: (r: (v: unknown) => unknown) => {
          if (patch && s.journey) Object.assign(s.journey, patch);
          const data =
            table === 'contact_tags'
              ? [{ contact_id: 'c1' }, { contact_id: 'c2' }]
              : table === 'tags'
                ? null
                : [];
          return Promise.resolve({ data, error: null }).then(r);
        },
      };
      return b;
    },
  };
}

vi.mock('@/lib/auth/account', async () => {
  const { NextResponse } = await import('next/server');
  return {
    getCurrentAccount: async () => ({ supabase: client(), accountId: 'acct', userId: 'u' }),
    requireRole: async () => ({ supabase: client(), accountId: 'acct', userId: 'u' }),
    toErrorResponse: (e: Error) => NextResponse.json({ error: e.message }, { status: 500 }),
  };
});
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => client() }));
vi.mock('@/lib/contacts/unsubscribe', () => ({
  getUnsubscribedContactIds: async () => new Set(['c2']),
}));
vi.mock('@/lib/journeys/engine', async (orig) => ({
  ...(await orig<typeof import('@/lib/journeys/engine')>()),
  enrollContact: vi.fn(async (_db: unknown, _j: unknown, contactId: string) => {
    s.enrolled.push(contactId);
    return { enrolled: true, outcome: 'waiting' };
  }),
}));

const { POST: setStatus } = await import('./[id]/status/route');
const { PUT: saveJourney } = await import('./[id]/route');
const { POST: enroll } = await import('./[id]/enroll/route');

const ID = '3f1c2b9e-7a44-4d0e-9a51-2c6b8d0e1f23';
const params = { params: Promise.resolve({ id: ID }) };
const req = (body: unknown) => new Request('https://x', { method: 'POST', body: JSON.stringify(body) });

function brokenGraph(): JourneyGraph {
  const g = starterGraph();
  g.nodes.push(newNode('send_template', { x: 0, y: 400 }, 'orphan'));
  return g;
}

beforeEach(() => {
  s.journey = { id: ID, status: 'draft', graph: starterGraph() };
  s.updates = [];
  s.enrolled = [];
});

describe('activation', () => {
  it('activates a valid journey', async () => {
    const res = await setStatus(req({ status: 'active' }), params);
    expect(res.status).toBe(200);
    expect(s.updates[0]).toMatchObject({ status: 'active' });
  });

  it('refuses to activate a journey with problems and lists them', async () => {
    s.journey!.graph = brokenGraph();
    const res = await setStatus(req({ status: 'active' }), params);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues.map((i: { nodeId: string }) => i.nodeId)).toContain('orphan');
    expect(s.updates).toEqual([]);
  });

  it('rejects unknown statuses', async () => {
    expect((await setStatus(req({ status: 'draft' }), params)).status).toBe(400);
  });
});

describe('saving', () => {
  it('saves a work-in-progress graph on a draft', async () => {
    const res = await saveJourney(req({ graph: brokenGraph() }), params);
    expect(res.status).toBe(200);
    expect(s.updates[0]).toMatchObject({ trigger_type: 'manual' });
  });

  it('refuses to save a broken graph onto a live journey', async () => {
    s.journey!.status = 'active';
    const res = await saveJourney(req({ graph: brokenGraph() }), params);
    expect(res.status).toBe(400);
    expect(s.updates).toEqual([]);
  });

  it('rejects malformed graphs and names', async () => {
    expect((await saveJourney(req({ graph: { nodes: [{ id: 'x' }] } }), params)).status).toBe(400);
    expect((await saveJourney(req({ name: '' }), params)).status).toBe(400);
  });
});

describe('manual enrollment', () => {
  it('needs an active journey', async () => {
    const res = await enroll(req({ tag_id: '11111111-1111-1111-1111-111111111111' }), params);
    expect(res.status).toBe(409);
  });

  it('enrolls tagged contacts and skips unsubscribed ones', async () => {
    s.journey!.status = 'active';
    const res = await enroll(req({ tag_id: '11111111-1111-1111-1111-111111111111' }), params);
    expect(await res.json()).toEqual({ enrolled: 1, skipped: 1 });
    expect(s.enrolled).toEqual(['c1']);
  });

  it('requires a tag or contact ids', async () => {
    s.journey!.status = 'active';
    expect((await enroll(req({}), params)).status).toBe(400);
  });
});

describe('removeNode', () => {
  it('removes a step and every connection into it, never the trigger', () => {
    const g = starterGraph();
    const mid = newNode('wait', { x: 0, y: 100 }, 'w');
    g.nodes[0].next.next = 'w';
    mid.next.next = 'end';
    g.nodes.push(mid);
    const after = removeNode(g, 'w');
    expect(after.nodes.map((n) => n.id)).toEqual(['trigger', 'end']);
    expect(after.nodes[0].next.next).toBeUndefined();
    expect(removeNode(g, 'trigger')).toBe(g);
  });
});
