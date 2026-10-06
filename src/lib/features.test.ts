import { describe, expect, it } from 'vitest';

import {
  FEATURE_INFO,
  FEATURES,
  featureDisabledBody,
  featureForPath,
  isFeature,
  isFeatureEnabled,
  parseDisabledFeatures,
} from './features';

describe('feature registry', () => {
  it('describes every feature', () => {
    for (const f of FEATURES) {
      expect(FEATURE_INFO[f].label).toBeTruthy();
      expect(FEATURE_INFO[f].description).toBeTruthy();
      for (const child of FEATURE_INFO[f].implies ?? []) expect(isFeature(child)).toBe(true);
    }
  });

  it('keys match the ones migration 045 gates in SQL', () => {
    // Renaming a key would orphan stored disabled_features values and
    // desync the RLS policies — this list is the contract.
    expect([...FEATURES]).toEqual([
      'pipelines',
      'broadcasts',
      'broadcast_scheduling',
      'automations',
      'flows',
      'ai_agents',
      'window_keepalive',
      'api_access',
      'button_analytics',
    ]);
  });
});

describe('isFeatureEnabled', () => {
  it('treats an empty or missing list as everything on', () => {
    for (const f of FEATURES) {
      expect(isFeatureEnabled([], f)).toBe(true);
      expect(isFeatureEnabled(null, f)).toBe(true);
      expect(isFeatureEnabled(undefined, f)).toBe(true);
    }
  });

  it('turns off exactly the listed features', () => {
    const disabled = ['pipelines', 'flows'];
    expect(isFeatureEnabled(disabled, 'pipelines')).toBe(false);
    expect(isFeatureEnabled(disabled, 'flows')).toBe(false);
    expect(isFeatureEnabled(disabled, 'broadcasts')).toBe(true);
    expect(isFeatureEnabled(disabled, 'ai_agents')).toBe(true);
  });

  it('turns off dependants with their parent', () => {
    expect(isFeatureEnabled(['broadcasts'], 'broadcast_scheduling')).toBe(false);
    expect(isFeatureEnabled(['ai_agents'], 'window_keepalive')).toBe(false);
    // …but not the other way round.
    expect(isFeatureEnabled(['broadcast_scheduling'], 'broadcasts')).toBe(true);
    expect(isFeatureEnabled(['window_keepalive'], 'ai_agents')).toBe(true);
  });
});

describe('parseDisabledFeatures', () => {
  it('dedupes and orders known keys', () => {
    expect(parseDisabledFeatures(['flows', 'pipelines', 'flows'])).toEqual({
      ok: true,
      value: ['pipelines', 'flows'],
    });
    expect(parseDisabledFeatures([])).toEqual({ ok: true, value: [] });
  });

  it('rejects unknown keys and non-arrays', () => {
    expect(parseDisabledFeatures(['pipelines', 'inbox']).ok).toBe(false);
    expect(parseDisabledFeatures('pipelines').ok).toBe(false);
    expect(parseDisabledFeatures(undefined).ok).toBe(false);
    expect(parseDisabledFeatures([42]).ok).toBe(false);
  });
});

describe('featureForPath', () => {
  it.each([
    ['/pipelines', 'pipelines'],
    ['/broadcasts', 'broadcasts'],
    ['/broadcasts/new', 'broadcasts'],
    ['/broadcasts/abc-123', 'broadcasts'],
    ['/automations/abc/edit', 'automations'],
    ['/flows/abc/runs', 'flows'],
    ['/agents', 'ai_agents'],
    ['/api/whatsapp/broadcast', 'broadcasts'],
    ['/api/whatsapp/broadcast/abc/resume', 'broadcasts'],
    ['/api/whatsapp/broadcast/abc/schedule', 'broadcast_scheduling'],
    ['/api/whatsapp/broadcast/abc/schedule/retry', 'broadcast_scheduling'],
    ['/api/automations', 'automations'],
    ['/api/automations/abc/duplicate', 'automations'],
    ['/api/flows/abc/activate', 'flows'],
    ['/api/ai/draft', 'ai_agents'],
    ['/api/ai/config', 'ai_agents'],
    ['/api/conversations/window-keepalive', 'window_keepalive'],
    ['/api/account/api-keys', 'api_access'],
    ['/api/account/api-keys/abc', 'api_access'],
    ['/button-clicks', 'button_analytics'],
    ['/api/button-clicks', 'button_analytics'],
  ])('%s → %s', (path, feature) => {
    expect(featureForPath(path)).toBe(feature);
  });

  it.each([
    '/dashboard',
    '/inbox',
    '/contacts',
    '/notifications',
    '/settings',
    '/admin',
    '/api/whatsapp/send',
    '/api/whatsapp/webhook',
    '/api/whatsapp/templates/sync',
    '/api/account/members',
    '/api/admin/users',
    // secret-authenticated system crons stay reachable
    '/api/automations/cron',
    '/api/flows/cron',
    // prefix look-alikes must not match
    '/broadcastsx',
    '/api/aix',
    '/agentsfoo',
  ])('%s is not gated', (path) => {
    expect(featureForPath(path)).toBeNull();
  });
});

describe('featureDisabledBody', () => {
  it('names the feature and carries a machine code', () => {
    expect(featureDisabledBody('pipelines')).toEqual({
      error: 'Pipelines & deals is not enabled for your account. Contact your administrator.',
      code: 'feature_disabled',
      feature: 'pipelines',
    });
  });
});
