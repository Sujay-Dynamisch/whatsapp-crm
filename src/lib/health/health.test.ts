import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const features = vi.hoisted(() => ({ off: new Set<string>() }));
vi.mock('@/lib/features-server', () => ({ accountHasFeature: async (_db: unknown, account: string) => !features.off.has(account) }));
vi.mock('@/lib/failed-messages/service', () => ({
  listFailed: async () => ({ items: [], stats: { failed: 5, open: 2, resolved: 3, scheduled: 0, window_open: 0 }, reasons: [] }),
}));

import { istYesterday, leadFeedChanged, recordHeartbeat, runDailySummaries, summaryText } from './health';

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;

function fakeDb(): SupabaseClient {
  return {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const preds: ((r: Row) => boolean)[] = [];
      let op: 'select' | 'insert' | 'update' | 'upsert' = 'select';
      let payload: Row[] = [];
      let patch: Row = {};
      let head = false;
      const run = () => {
        if (op === 'insert') {
          if (table === 'health_summaries' && payload.some((p) => rows.some((r) => r.account_id === p.account_id && r.day === p.day))) {
            return { data: null, error: { code: '23505', message: 'duplicate' } };
          }
          rows.push(...payload);
          return { data: null, error: null };
        }
        if (op === 'upsert') {
          for (const p of payload) {
            const hit = rows.find((r) => r.name === p.name);
            if (hit) Object.assign(hit, p);
            else rows.push(p);
          }
          return { data: null, error: null };
        }
        const hit = rows.filter((r) => preds.every((p) => p(r)));
        if (op === 'update') {
          for (const r of hit) Object.assign(r, patch);
          return { data: null, error: null };
        }
        return head ? { data: null, count: hit.length, error: null } : { data: hit.map((r) => ({ ...r })), error: null };
      };
      const b: Record<string, unknown> = {
        select: (_c?: string, o?: { head?: boolean }) => ((head = Boolean(o?.head)), b),
        insert: (r: Row | Row[]) => ((op = 'insert'), (payload = Array.isArray(r) ? r : [r]), b),
        upsert: (r: Row | Row[]) => ((op = 'upsert'), (payload = Array.isArray(r) ? r : [r]), b),
        update: (p: Row) => ((op = 'update'), (patch = p), b),
        eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), b),
        gte: (c: string, v: string) => (preds.push((r) => String(r[c]) >= v), b),
        lt: (c: string, v: string) => (preds.push((r) => String(r[c]) < v), b),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}
const db = () => fakeDb();

beforeEach(() => {
  features.off.clear();
  tables = {
    accounts: [
      { id: 'a1', disabled_features: [] },
      { id: 'a2', disabled_features: ['failed_messages'] },
    ],
    profiles: [
      { user_id: 'owner', account_id: 'a1', account_role: 'owner' },
      { user_id: 'admin', account_id: 'a1', account_role: 'admin' },
      { user_id: 'agent', account_id: 'a1', account_role: 'agent' },
      { user_id: 'owner2', account_id: 'a2', account_role: 'owner' },
    ],
    lead_sync_issues: [{ account_id: 'a1', created_at: '2026-11-02T06:00:00.000Z' }, { account_id: 'a1', created_at: '2026-11-03T06:00:00.000Z' }],
    lead_sync_sources: [{ account_id: 'a1', enabled: true, last_report: { error: 'source responded 500' } }],
    notifications: [],
    health_summaries: [],
    system_heartbeats: [],
  };
});

describe('daily summary', () => {
  it('yesterday in IST', () => {
    expect(istYesterday(new Date('2026-11-03T04:00:00Z'))).toEqual({
      day: '2026-11-02',
      from: '2026-11-01T18:30:00.000Z',
      to: '2026-11-02T18:30:00.000Z',
    });
    // 00:30 IST on the 3rd is still "yesterday = 2nd".
    expect(istYesterday(new Date('2026-11-02T19:00:00Z')).day).toBe('2026-11-02');
  });

  it('nothing before 9 AM IST; after, once per account with the feature, to owners/admins only', async () => {
    expect((await runDailySummaries(db(), new Date('2026-11-03T03:00:00Z'))).sent).toBe(0); // 8:30 IST
    expect((await runDailySummaries(db(), new Date('2026-11-03T03:31:00Z'))).sent).toBe(1); // 9:01 IST
    expect(tables.notifications.map((n) => n.user_id)).toEqual(['owner', 'admin']);
    expect(tables.notifications[0]).toMatchObject({
      account_id: 'a1',
      type: 'health_summary',
      title: '⚠ Daily health — 2 Nov',
      body: '5 messages failed (3 fixed, 2 still open) · 1 registration skipped (invalid phone) · lead feed FAILING: source responded 500',
    });
    expect(tables.health_summaries[0]).toMatchObject({ account_id: 'a1', day: '2026-11-02', summary: expect.objectContaining({ failed: 5 }) });
    expect((await runDailySummaries(db(), new Date('2026-11-03T10:00:00Z'))).sent).toBe(0); // already sent today
  });

  it('a quiet day reads as all good', () => {
    expect(
      summaryText({ day: '2026-11-02', failed: 0, fixed: 0, still_open: 0, skipped_registrations: 0, lead_feed: 'ok', lead_feed_error: null })
    ).toEqual({ title: '✓ Daily health — 2 Nov', body: 'No failed messages · no skipped registrations · lead feed OK' });
  });
});

describe('lead feed alerts', () => {
  it('only when the state changes, only with the feature on', async () => {
    await leadFeedChanged(db(), 'a1', null, null);
    await leadFeedChanged(db(), 'a1', 'x', 'y');
    expect(tables.notifications).toEqual([]);
    await leadFeedChanged(db(), 'a1', null, 'source responded 500');
    expect(tables.notifications.map((n) => [n.user_id, n.type, n.title])).toEqual([
      ['owner', 'health_alert', 'Website lead feed is failing — new registrations are not coming in'],
      ['admin', 'health_alert', 'Website lead feed is failing — new registrations are not coming in'],
    ]);
    await leadFeedChanged(db(), 'a1', 'source responded 500', null);
    expect(tables.notifications.at(-1)!.title).toBe('Website lead feed is working again');
    features.off.add('a1');
    await leadFeedChanged(db(), 'a1', null, 'down');
    expect(tables.notifications).toHaveLength(4);
  });
});

describe('heartbeat', () => {
  it('upserts one row per name', async () => {
    await recordHeartbeat(db(), 'journey_tick', { claimed: 1 }, new Date('2026-11-03T00:00:00Z'));
    await recordHeartbeat(db(), 'journey_tick', { claimed: 2 }, new Date('2026-11-03T00:01:00Z'));
    expect(tables.system_heartbeats).toEqual([{ name: 'journey_tick', last_at: '2026-11-03T00:01:00.000Z', report: { claimed: 2 } }]);
  });
});
