import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/features-server', () => ({ accountHasFeature: async () => true }));

import { runWebinarGapAlerts, webinarGap } from './gap';

type Row = Record<string, unknown>;

/** Minimal fake for the queries gap.ts runs. */
function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const preds: ((r: Row) => boolean)[] = [];
      let head = false;
      let insert: Row[] | null = null;
      const b: Record<string, unknown> = {
        select: (_c: string, o?: { head?: boolean }) => ((head = !!o?.head), b),
        eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), b),
        in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), b),
        gte: (c: string, v: string) => (preds.push((r) => String(r[c]) >= v), b),
        lt: (c: string, v: string) => (preds.push((r) => String(r[c]) < v), b),
        ilike: (c: string, v: string) => (preds.push((r) => String(r[c]).toLowerCase().includes(v.replace(/%/g, '').toLowerCase())), b),
        limit: () => b,
        insert: (r: Row[]) => ((insert = r), b),
        then: (res: (v: unknown) => unknown) => {
          if (insert) {
            rows.push(...insert.map((r) => ({ ...r, created_at: new Date().toISOString() })));
            return Promise.resolve({ data: null, error: null }).then(res);
          }
          const hit = rows.filter((r) => preds.every((p) => p(r)));
          return Promise.resolve(head ? { count: hit.length, data: null, error: null } : { data: hit, error: null }).then(res);
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const at = (ist: string) => new Date(Date.parse(`${ist.replace(' ', 'T')}:00+05:30`));
const base = () => ({
  webinar_sessions: [{ account_id: 'a', status: 'scheduled', starts_at: at('2026-11-27 20:00').toISOString(), id: 's1' }],
  journey_enrollments: [] as Row[],
  profiles: [
    { account_id: 'a', user_id: 'owner', account_role: 'owner' },
    { account_id: 'a', user_id: 'caller', account_role: 'agent' },
  ],
  notifications: [] as Row[],
});

describe('webinar gap', () => {
  it('flags a missing next-day session and counts queued leads', async () => {
    const t = base();
    t.journey_enrollments.push({ account_id: 'a', status: 'waiting', current_node_id: 'wait_session' });
    const g = await webinarGap(fakeDb(t), 'a', at('2026-11-27 12:00'));
    expect(g).toMatchObject({ nextDayMissing: true, queued: 1, nextDayLabel: expect.stringContaining('28') });
  });

  it('reminds admins (not callers) at 1 PM, once per slot', async () => {
    const t = base();
    const db = fakeDb(t);
    expect((await runWebinarGapAlerts(db, at('2026-11-27 12:30'))).alerted).toBe(0); // not a slot, nobody queued
    expect((await runWebinarGapAlerts(db, at('2026-11-27 13:01'))).alerted).toBe(1);
    expect(t.notifications.map((n) => n.user_id)).toEqual(['owner']);
    expect(t.notifications[0].title).toMatch(/^Add the webinar session for /);
    expect((await runWebinarGapAlerts(db, at('2026-11-27 13:05'))).alerted).toBe(0); // same slot
  });

  it('no reminder when tomorrow is already scheduled', async () => {
    const t = base();
    t.webinar_sessions.push({ account_id: 'a', status: 'scheduled', starts_at: at('2026-11-28 20:00').toISOString(), id: 's2' });
    expect((await runWebinarGapAlerts(fakeDb(t), at('2026-11-27 14:02'))).alerted).toBe(0);
  });
});
