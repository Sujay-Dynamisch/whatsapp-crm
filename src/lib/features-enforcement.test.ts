// ============================================================
// Background enforcement of account features (migration 045).
//
// The webhook and the crons run with the service-role client, which
// bypasses RLS — so these engine entry points are the ONLY thing
// stopping a switched-off feature from messaging customers. Each test
// switches the feature off and proves the engine stops before doing
// any work.
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  enabled: true,
  featureChecks: [] as { accountId: string; feature: string }[],
  tables: [] as string[],
  updates: [] as { table: string; patch: unknown }[],
}));

vi.mock('@/lib/features-server', () => ({
  accountHasFeature: vi.fn(async (_db: unknown, accountId: string, feature: string) => {
    state.featureChecks.push({ accountId, feature });
    return state.enabled;
  }),
  loadDisabledFeatures: vi.fn(async () => []),
}));

/** Records every table touched; `automations` resolves to one row. */
function recordingDb() {
  return {
    from(table: string) {
      state.tables.push(table);
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: () => b,
        is: () => b,
        limit: () => b,
        order: () => b,
        update: (patch: unknown) => (state.updates.push({ table, patch }), b),
        single: async () => ({
          data: table === 'automations' ? { id: 'auto-1', account_id: 'acct-1' } : null,
          error: null,
        }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => recordingDb() }));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => recordingDb() }));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => recordingDb() }));

const loadAiConfig = vi.fn();
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: (...a: unknown[]) => loadAiConfig(...a) }));

const { dispatchInboundToAiReply } = await import('@/lib/ai/auto-reply');
const { runAutomationsForTrigger, resumePendingExecution } = await import(
  '@/lib/automations/engine'
);
const { dispatchInboundToFlows } = await import('@/lib/flows/engine');

beforeEach(() => {
  state.enabled = false;
  state.featureChecks = [];
  state.tables = [];
  state.updates = [];
  loadAiConfig.mockReset();
});

describe('AI auto-reply (webhook)', () => {
  it('does nothing when AI Agents is switched off', async () => {
    await dispatchInboundToAiReply({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      configOwnerUserId: 'user-1',
    });
    expect(state.featureChecks).toEqual([{ accountId: 'acct-1', feature: 'ai_agents' }]);
    expect(loadAiConfig).not.toHaveBeenCalled();
    expect(state.tables).toEqual([]);
  });

  it('proceeds past the gate when enabled', async () => {
    state.enabled = true;
    loadAiConfig.mockResolvedValue(null); // AI not configured → stops at the next gate
    await dispatchInboundToAiReply({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      configOwnerUserId: 'user-1',
    });
    expect(loadAiConfig).toHaveBeenCalled();
  });
});

describe('automations engine', () => {
  it('does not look up or fire automations when switched off', async () => {
    await runAutomationsForTrigger({
      accountId: 'acct-1',
      triggerType: 'new_message_received',
      contactId: 'contact-1',
    });
    expect(state.featureChecks).toEqual([{ accountId: 'acct-1', feature: 'automations' }]);
    expect(state.tables).toEqual([]);
  });

  it('does not resume a run parked at a wait step after being switched off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await resumePendingExecution({
      id: 'pending-1',
      automation_id: 'auto-1',
      user_id: 'user-1',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      log_id: null,
      parent_step_id: null,
      branch: null,
      next_step_position: 2,
      context: {},
    });
    expect(state.featureChecks).toEqual([{ accountId: 'acct-1', feature: 'automations' }]);
    // Only the automation lookup and the pending row being closed out.
    expect(state.tables).toEqual(['automations', 'automation_pending_executions']);
    expect(state.updates).toEqual([
      { table: 'automation_pending_executions', patch: { status: 'failed' } },
    ]);
    warn.mockRestore();
  });
});

describe('flows engine', () => {
  it('does not consume the message when switched off, so the webhook falls through', async () => {
    const result = await dispatchInboundToFlows({
      accountId: 'acct-1',
      userId: 'user-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      message: { type: 'text', text: 'hi', meta_message_id: 'wamid.1' } as never,
      isFirstInboundMessage: true,
    });
    expect(result).toEqual({ consumed: false, outcome: 'no_match' });
    expect(state.featureChecks).toEqual([{ accountId: 'acct-1', feature: 'flows' }]);
    expect(state.tables).toEqual([]);
  });
});
