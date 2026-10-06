// ============================================================
// Per-account feature entitlements (migration 045).
//
// The system admin switches features off per customer account
// (accounts.disabled_features). Everything not listed there is on, so
// a new feature key defaults to enabled for every existing customer.
//
// Enforcement happens in four places, all keyed off this file:
//   - UI         sidebar + <FeatureGate> (useFeature)
//   - requests   middleware → featureForPath() → 403 / redirect
//   - database   RESTRICTIVE RLS write policies (account_has_feature)
//   - workers    webhook dispatch, schedulers → isFeatureEnabled()
//
// Core pages (dashboard, inbox, contacts, notifications, settings) are
// deliberately not gateable — without them the CRM doesn't function.
//
// Keys are persisted in the DB; never rename one, only add.
// ============================================================

export const FEATURES = [
  'pipelines',
  'broadcasts',
  'broadcast_scheduling',
  'automations',
  'flows',
  'ai_agents',
  'window_keepalive',
  'api_access',
  'button_analytics',
] as const;

export type Feature = (typeof FEATURES)[number];

export interface FeatureInfo {
  label: string;
  description: string;
  /** Turning this off also turns these off (they depend on it). */
  implies?: Feature[];
}

export const FEATURE_INFO: Record<Feature, FeatureInfo> = {
  pipelines: {
    label: 'Pipelines & deals',
    description: 'Sales pipelines, stages and deals.',
  },
  broadcasts: {
    label: 'Broadcasts',
    description: 'Bulk template campaigns to contacts.',
    implies: ['broadcast_scheduling'],
  },
  broadcast_scheduling: {
    label: 'Scheduled broadcasts',
    description: 'Schedule broadcasts for a future time (Google Cloud).',
  },
  automations: {
    label: 'Automations',
    description: 'Trigger-based automations and wait steps.',
  },
  flows: {
    label: 'Flows',
    description: 'Visual chatbot flows.',
  },
  ai_agents: {
    label: 'AI Agents',
    description: 'AI drafts, auto-replies, knowledge base and playground.',
    implies: ['window_keepalive'],
  },
  window_keepalive: {
    label: '24h window keep-alive',
    description: 'Automatic check-in before the WhatsApp 24-hour window closes.',
  },
  button_analytics: {
    label: 'Button click analytics',
    description: 'Track which template and interactive buttons customers tap.',
  },
  api_access: {
    label: 'API & webhooks',
    description: 'Public REST API keys and outbound webhooks.',
  },
};

export function isFeature(value: unknown): value is Feature {
  return typeof value === 'string' && (FEATURES as readonly string[]).includes(value);
}

/**
 * Whether `feature` is usable for an account with this disabled list.
 * A feature is also off when something it depends on is off
 * (scheduling needs broadcasts; keep-alive lives under AI Agents).
 */
export function isFeatureEnabled(
  disabled: readonly string[] | null | undefined,
  feature: Feature
): boolean {
  if (!disabled || disabled.length === 0) return true;
  if (disabled.includes(feature)) return false;
  for (const [parent, info] of Object.entries(FEATURE_INFO) as [Feature, FeatureInfo][]) {
    if (info.implies?.includes(feature) && disabled.includes(parent)) return false;
  }
  return true;
}

/**
 * Normalise an admin-submitted list: known keys only, deduplicated,
 * stable order. Unknown keys are rejected rather than silently stored.
 */
export function parseDisabledFeatures(
  input: unknown
): { ok: true; value: Feature[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'disabled_features must be an array of feature keys' };
  }
  const unknown = input.filter((f) => !isFeature(f));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown feature key(s): ${unknown.map(String).join(', ')}` };
  }
  const set = new Set(input as Feature[]);
  return { ok: true, value: FEATURES.filter((f) => set.has(f)) };
}

// ------------------------------------------------------------------
// Path → feature
// ------------------------------------------------------------------

/**
 * Prefixes owned by a feature. Order matters: first match wins, so the
 * more specific prefix (schedule) precedes the general one (broadcast).
 * Cron endpoints are absent on purpose — they're secret-authenticated
 * system calls, and the engines they drive check the feature per
 * account themselves.
 */
const PATH_RULES: { prefix: string; feature: Feature }[] = [
  // Pages
  { prefix: '/pipelines', feature: 'pipelines' },
  { prefix: '/broadcasts', feature: 'broadcasts' },
  { prefix: '/automations', feature: 'automations' },
  { prefix: '/flows', feature: 'flows' },
  { prefix: '/agents', feature: 'ai_agents' },
  { prefix: '/button-clicks', feature: 'button_analytics' },
  // Internal APIs
  { prefix: '/api/whatsapp/broadcast', feature: 'broadcasts' },
  { prefix: '/api/automations', feature: 'automations' },
  { prefix: '/api/flows', feature: 'flows' },
  { prefix: '/api/ai', feature: 'ai_agents' },
  { prefix: '/api/conversations/window-keepalive', feature: 'window_keepalive' },
  { prefix: '/api/account/api-keys', feature: 'api_access' },
  { prefix: '/api/button-clicks', feature: 'button_analytics' },
];

const UNGATED = ['/api/automations/cron', '/api/flows/cron'];

function matches(pathname: string, prefix: string): boolean {
  return (
    pathname === prefix ||
    pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
  );
}

/** The feature a request path belongs to, or null for ungated paths. */
export function featureForPath(pathname: string): Feature | null {
  if (UNGATED.some((p) => matches(pathname, p))) return null;
  // /api/whatsapp/broadcast/<id>/schedule[/retry]
  if (/^\/api\/whatsapp\/broadcast\/[^/]+\/schedule(\/|$)/.test(pathname)) {
    return 'broadcast_scheduling';
  }
  for (const rule of PATH_RULES) {
    if (matches(pathname, rule.prefix)) return rule.feature;
  }
  return null;
}

/** Error body for a blocked request — shared by middleware and routes. */
export function featureDisabledBody(feature: Feature) {
  return {
    error: `${FEATURE_INFO[feature].label} is not enabled for your account. Contact your administrator.`,
    code: 'feature_disabled',
    feature,
  };
}
