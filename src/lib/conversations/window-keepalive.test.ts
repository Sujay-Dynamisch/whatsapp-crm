import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: vi.fn() }));

import { runWindowKeepalive, type ClaimedKeepalive } from './window-keepalive';
import { parseKeepaliveSettings } from './window-keepalive-settings';

interface Update {
  table: string;
  patch: Record<string, unknown>;
  filters: Record<string, unknown>;
}

function fakeDb(claimed: ClaimedKeepalive[], updates: Update[]): SupabaseClient {
  return {
    rpc: vi.fn(async () => ({ data: claimed, error: null })),
    from(table: string) {
      const u: Update = { table, patch: {}, filters: {} };
      const b: Record<string, unknown> = {
        select: () => b,
        update: (patch: Record<string, unknown>) => {
          u.patch = patch;
          updates.push(u);
          return b;
        },
        eq: (c: string, v: unknown) => ((u.filters[c] = v), b),
        maybeSingle: async () => ({ data: { user_id: 'owner-1' }, error: null }),
        then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const row = (id: string): ClaimedKeepalive => ({
  conversation_id: id,
  account_id: 'acct-1',
  contact_id: `contact-${id}`,
  window_opened_at: '2026-10-05T10:00:00+00:00',
  message_text: 'Still there?',
});

describe('runWindowKeepalive', () => {
  it('sends the configured text to every claimed conversation and stamps it', async () => {
    const updates: Update[] = [];
    const send = vi.fn(async () => ({ whatsapp_message_id: 'wamid' }));
    const report = await runWindowKeepalive(fakeDb([row('c1'), row('c2')], updates), { send });

    expect(report).toMatchObject({ claimed: 2, sent: ['c1', 'c2'], failed: [] });
    expect(send).toHaveBeenCalledWith({
      accountId: 'acct-1',
      userId: 'owner-1',
      conversationId: 'c1',
      contactId: 'contact-c1',
      text: 'Still there?',
    });
    expect(updates.filter((u) => 'window_keepalive_sent_at' in u.patch)).toHaveLength(2);
  });

  it('releases the claim on failure (only for the same window) so the next sweep can retry', async () => {
    const updates: Update[] = [];
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('Meta 500'))
      .mockResolvedValueOnce({ whatsapp_message_id: 'wamid' });
    const report = await runWindowKeepalive(fakeDb([row('c1'), row('c2')], updates), { send });

    expect(report.sent).toEqual(['c2']);
    expect(report.failed).toEqual([{ conversationId: 'c1', error: 'Meta 500' }]);
    const release = updates.find((u) => u.patch.window_keepalive_for === null)!;
    expect(release.filters).toEqual({
      id: 'c1',
      window_keepalive_for: '2026-10-05T10:00:00+00:00',
    });
  });

  it('does nothing when no conversation is due', async () => {
    const send = vi.fn();
    const report = await runWindowKeepalive(fakeDb([], []), { send });
    expect(report.claimed).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('parseKeepaliveSettings', () => {
  it('accepts valid settings and trims the text', () => {
    expect(
      parseKeepaliveSettings({ enabled: true, lead_minutes: 60, quiet_minutes: 0, message_text: '  Hi  ' })
    ).toEqual({
      ok: true,
      value: { enabled: true, lead_minutes: 60, quiet_minutes: 0, message_text: 'Hi' },
    });
  });

  it('rejects out-of-range timing and empty text', () => {
    expect(parseKeepaliveSettings({ lead_minutes: 5 }).ok).toBe(false);
    expect(parseKeepaliveSettings({ lead_minutes: 300 }).ok).toBe(false);
    expect(parseKeepaliveSettings({ quiet_minutes: -1 }).ok).toBe(false);
    expect(parseKeepaliveSettings({ message_text: '   ' }).ok).toBe(false);
  });
});
