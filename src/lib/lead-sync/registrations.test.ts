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

import { runLeadSync } from './registrations';

// Minimal query builder: lead_sync_sources select / update, custom_fields lookups.
function fakeDb(): SupabaseClient {
  const builder = (data: unknown) => {
    const b: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'ilike', 'limit', 'update', 'insert']) b[k] = () => b;
    b.maybeSingle = async () => ({ data: { id: 'city-field' }, error: null });
    b.single = b.maybeSingle;
    b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res);
    return b;
  };
  return {
    from: (table: string) =>
      builder(table === 'lead_sync_sources' ? [{ account_id: 'acct', source_url: 'https://src.example/regs', tag: 'webinar' }] : null),
  } as unknown as SupabaseClient;
}

const NOW = new Date('2026-11-02T05:00:00Z');

beforeEach(() => {
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
    expect(out.acct).toMatchObject({ fetched: 2, created: 1, existing: 1, restarted: 1 });
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
});
