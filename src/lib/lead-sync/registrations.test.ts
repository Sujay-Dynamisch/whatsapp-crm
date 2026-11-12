import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const contacts = vi.hoisted(() => ({ created: new Map<string, boolean>() }));
vi.mock('@/lib/api/v1/contacts', () => ({
  resolveAuditUserId: async () => 'owner',
  setContactTags: async () => undefined,
  findOrCreateContact: async (_db: unknown, _acct: string, _user: string, c: { phone: string }) => ({
    id: `contact-${c.phone}`,
    created: contacts.created.get(c.phone) ?? false,
  }),
}));
const journeys = vi.hoisted(() => ({ dispatch: vi.fn(async () => 1), restart: vi.fn(async () => 1) }));
vi.mock('@/lib/journeys/dispatch', () => ({
  dispatchJourneyTrigger: journeys.dispatch,
  restartJourneysOnReregistration: journeys.restart,
}));

// Caller management (086) is off unless a test turns it on.
const features = vi.hoisted(() => ({ managed: false }));
vi.mock('@/lib/features-server', () => ({
  accountHasFeature: async (_db: unknown, _acct: string, f: string) => (f === 'caller_management' ? features.managed : true),
}));

const health = vi.hoisted(() => ({ leadFeedChanged: vi.fn(async () => undefined) }));
vi.mock('@/lib/health/health', () => health);

import { runLeadSync } from './registrations';

// Minimal query builder: lead_sync_sources select / update, custom_fields lookups.
let upserts: { table: string; row: Record<string, unknown>; opts: unknown }[] = [];
let sourceReport: unknown = null;
let rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let verdicts: Record<string, { accepted: boolean; reason: string }> = {};
function fakeDb(): SupabaseClient {
  const builder = (data: unknown, table: string) => {
    const b: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'ilike', 'limit', 'update', 'insert']) b[k] = () => b;
    b.upsert = (row: Record<string, unknown>, opts: unknown) => (upserts.push({ table, row, opts }), b);
    b.maybeSingle = async () => ({ data: { id: 'city-field' }, error: null });
    b.single = b.maybeSingle;
    b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res);
    return b;
  };
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: verdicts[args.p_registration_id as string] ?? { accepted: true, reason: 'ROUND_ROBIN' }, error: null };
    },
    from: (table: string) =>
      builder(
        table === 'lead_sync_sources'
          ? [{ account_id: 'acct', source_url: 'https://src.example/regs', tag: 'webinar', last_report: sourceReport }]
          : null,
        table
      ),
  } as unknown as SupabaseClient;
}

const NOW = new Date('2026-11-02T05:00:00Z');

beforeEach(() => {
  upserts = [];
  rpcCalls = [];
  verdicts = {};
  features.managed = false;
  sourceReport = null;
  health.leadFeedChanged.mockClear();
  contacts.created.clear();
  journeys.dispatch.mockClear();
  journeys.restart.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { _id: 'r-new', fullName: 'New Lead', whatsappNumber: '9800000001', createdAt: '2026-11-02T04:58:00Z' },
            { _id: 'r-again', fullName: 'Old Lead', whatsappNumber: '9800000002', createdAt: '2026-11-02T04:59:00Z' },
            { _id: 'r-bad', fullName: 'Typo Lead', whatsappNumber: '12345', email: 'typo@x.com', city: 'Pune', createdAt: '2026-11-02T04:57:00Z' },
          ],
          totalPages: 1,
        })
      )
    )
  );
});

describe('lead sync → journeys', () => {
  it('new contact → starts the journey with the registration id; existing contact → restart check', async () => {
    contacts.created.set('+919800000001', true);
    const out = await runLeadSync(fakeDb(), NOW);
    expect(out.acct).toMatchObject({ fetched: 3, created: 1, existing: 1, restarted: 1, skipped: 1 });
    expect(journeys.dispatch).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'acct',
      contactId: 'contact-+919800000001',
      trigger: 'contact_created',
      source: 'api',
      data: { source: 'api', registration_id: 'r-new', registered_at: '2026-11-02T04:58:00Z' },
    });
    expect(journeys.restart).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'acct',
      contactId: 'contact-+919800000002',
      registrationId: 'r-again',
      registeredAt: '2026-11-02T04:59:00Z',
    });
  });

  it('caller management: every registration goes through accept_registration; a repeat inside 15 days is suppressed', async () => {
    features.managed = true;
    contacts.created.set('+919800000001', true);
    verdicts['r-again'] = { accepted: false, reason: 'within_15_days' };
    const out = await runLeadSync(fakeDb(), NOW);
    expect(rpcCalls.map((c) => c.args.p_registration_id)).toEqual(['r-new', 'r-again']);
    expect(out.acct).toMatchObject({ created: 1, existing: 1, restarted: 0, suppressed: 1 });
    expect(journeys.dispatch).toHaveBeenCalledTimes(1);
    expect(journeys.restart).not.toHaveBeenCalled();
  });

  it('an invalid number is kept for a human to fix — once per registration', async () => {
    await runLeadSync(fakeDb(), NOW);
    expect(upserts).toEqual([
      {
        table: 'lead_sync_issues',
        row: expect.objectContaining({ account_id: 'acct', registration_id: 'r-bad', kind: 'invalid_phone', raw_phone: '12345', name: 'Typo Lead', email: 'typo@x.com', city: 'Pune' }),
        opts: { onConflict: 'account_id,registration_id,kind', ignoreDuplicates: true },
      },
    ]);
  });

  it('tells health about the feed state (previous vs now)', async () => {
    sourceReport = { error: 'source responded 500' };
    await runLeadSync(fakeDb(), NOW);
    expect(health.leadFeedChanged).toHaveBeenCalledWith(expect.anything(), 'acct', 'source responded 500', null);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    sourceReport = null;
    await runLeadSync(fakeDb(), NOW);
    expect(health.leadFeedChanged).toHaveBeenLastCalledWith(expect.anything(), 'acct', null, 'source responded 503');
  });
});
