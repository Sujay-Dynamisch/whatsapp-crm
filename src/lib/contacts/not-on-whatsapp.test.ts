import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { markIfNotOnWhatsApp } from './not-on-whatsapp';
import { normalizePhone } from './whatsapp-restart';

type Row = Record<string, unknown>;
function fakeDb(t: Record<string, Row[]>) {
  return {
    from(table: string) {
      const rows = (t[table] ??= []);
      const preds: ((r: Row) => boolean)[] = [];
      let head = false;
      let op: 'select' | 'insert' | 'upsert' | 'update' = 'select';
      let payload: Row | Row[] | null = null;
      const b: Record<string, unknown> = {
        select: (_c?: string, o?: { head?: boolean }) => ((head = !!o?.head), b),
        insert: (r: Row) => ((op = 'insert'), (payload = r), b),
        upsert: (r: Row) => ((op = 'upsert'), (payload = r), b),
        update: (r: Row) => ((op = 'update'), (payload = r), b),
        eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), b),
        in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), b),
        is: (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), b),
        ilike: (c: string, v: string) => (preds.push((r) => String(r[c]).toLowerCase() === v.toLowerCase()), b),
        maybeSingle: () => b,
        single: () => b,
        then: (res: (v: unknown) => unknown) => {
          const hit = rows.filter((r) => preds.every((p) => p(r)));
          if (op === 'insert' || op === 'upsert') {
            const r = { id: `${table}-${rows.length + 1}`, ...(payload as Row) };
            rows.push(r);
            return Promise.resolve({ data: r, error: null }).then(res);
          }
          if (op === 'update') {
            hit.forEach((r) => Object.assign(r, payload));
            return Promise.resolve({ data: hit, error: null }).then(res);
          }
          if (head) return Promise.resolve({ count: hit.length, data: null, error: null }).then(res);
          return Promise.resolve({ data: hit[0] ?? null, error: null }).then(res);
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}
const failed = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, contact_id: 'c1', status: 'failed', error_code: 131026 }));

describe('markIfNotOnWhatsApp', () => {
  it('tags after the 2nd undeliverable failure and stops the waiting run', async () => {
    const t: Record<string, Row[]> = {
      journey_messages: failed(2),
      accounts: [{ id: 'a', owner_user_id: 'o' }],
      journey_enrollments: [{ id: 'r1', contact_id: 'c1', status: 'waiting' }],
    };
    expect(await markIfNotOnWhatsApp(fakeDb(t), 'a', 'c1')).toBe(true);
    expect(t.contact_tags).toHaveLength(1);
    expect(t.journey_enrollments[0]).toMatchObject({ status: 'exited', last_error: 'Number not on WhatsApp' });
    expect(t.journey_messages.every((m) => m.resolved === 'dismissed')).toBe(true);
  });

  it('one failure is not enough', async () => {
    expect(await markIfNotOnWhatsApp(fakeDb({ journey_messages: failed(1) }), 'a', 'c1')).toBe(false);
  });

  it('never tags a number that was reached before (delivered message)', async () => {
    const t = { journey_messages: [...failed(3), { id: 'ok', contact_id: 'c1', status: 'delivered' }] };
    expect(await markIfNotOnWhatsApp(fakeDb(t), 'a', 'c1')).toBe(false);
  });
});

describe('normalizePhone', () => {
  it('adds 91 to a 10-digit number and rejects junk', () => {
    expect(normalizePhone('98765 43210')).toBe('919876543210');
    expect(normalizePhone('+91 98765-43210')).toBe('919876543210');
    expect(normalizePhone('12345')).toBeNull();
  });
});
