// ============================================================
// Custom roles — areas and access levels (migration 062). Pure.
//
// A custom role is a base role (admin / agent / viewer) plus a level
// per area: none (hidden, blocked), view (read-only), edit. It can only
// RESTRICT its base role — a viewer-based role never edits, and only
// admin-based roles edit admin areas (settings, templates, AI, team, API).
//
// Enforced in four places, all keyed off this file:
//   - database   RESTRICTIVE policies via my_area_level() (062 — keep the
//                area keys in sync with that migration's table list)
//   - requests   middleware → areaForPath() → redirect / 403
//   - UI         sidebar, settings rail, <FeatureGate> view-only notice
//   - roles API  clampPermissions() before saving
//
// Members without a custom role keep today's behaviour (full access
// for their built-in role). Keys are stored in the DB: only add.
// ============================================================

import { hasMinRole, type AccountRole } from './roles';
import type { Feature } from '../features';

export const AREAS = [
  'inbox',
  'contacts',
  'pipelines',
  'broadcasts',
  'templates',
  'automations',
  'flows',
  'journeys',
  'ai_agents',
  'callbacks',
  'payments',
  'callers',
  'button_clicks',
  'failed_messages',
  'settings',
  'members',
  'api_access',
] as const;

export type Area = (typeof AREAS)[number];
export type AccessLevel = 'none' | 'view' | 'edit';
export const ACCESS_LEVELS: AccessLevel[] = ['none', 'view', 'edit'];
export type Permissions = Record<Area, AccessLevel>;
export type CustomBaseRole = Exclude<AccountRole, 'owner'>;
export const CUSTOM_BASE_ROLES: CustomBaseRole[] = ['admin', 'agent', 'viewer'];

/** The caller's custom role (my_permissions()), or null = no restrictions. */
export interface MyAccess {
  custom_role_id: string;
  name: string;
  base_role: CustomBaseRole;
  permissions: Partial<Record<string, AccessLevel>>;
}

/** my_permissions() result → MyAccess (anything else = no custom role). */
export function parseAccess(raw: unknown): MyAccess | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.custom_role_id !== 'string' || !r.permissions || typeof r.permissions !== 'object') return null;
  return {
    custom_role_id: r.custom_role_id,
    name: typeof r.name === 'string' ? r.name : '',
    base_role: (CUSTOM_BASE_ROLES as string[]).includes(String(r.base_role)) ? (r.base_role as CustomBaseRole) : 'viewer',
    permissions: r.permissions as Partial<Record<string, AccessLevel>>,
  };
}

/** Areas only admins may edit (account-wide configuration). */
const ADMIN_EDIT: Area[] = ['templates', 'ai_agents', 'settings', 'members', 'api_access'];

/** The account feature an area belongs to (hidden when the feature is off). */
export const AREA_FEATURE: Partial<Record<Area, Feature>> = {
  pipelines: 'pipelines',
  broadcasts: 'broadcasts',
  automations: 'automations',
  flows: 'flows',
  journeys: 'journeys',
  ai_agents: 'ai_agents',
  callbacks: 'callbacks',
  payments: 'payments',
  callers: 'caller_management',
  button_clicks: 'button_analytics',
  failed_messages: 'failed_messages',
  api_access: 'api_access',
};

/** Pages that only read (Edit adds nothing there). */
export const VIEW_ONLY_AREAS: Area[] = ['button_clicks'];

const RANK: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2 };

export function isArea(v: unknown): v is Area {
  return typeof v === 'string' && (AREAS as readonly string[]).includes(v);
}
export function isAccessLevel(v: unknown): v is AccessLevel {
  return v === 'none' || v === 'view' || v === 'edit';
}
export function atLeast(level: AccessLevel, min: AccessLevel): boolean {
  return RANK[level] >= RANK[min];
}

/** Most a base role allows in an area. */
export function maxLevel(base: AccountRole, area: Area): AccessLevel {
  if (base === 'owner' || base === 'admin') return 'edit';
  if (base === 'viewer') return 'view';
  return ADMIN_EDIT.includes(area) ? 'view' : 'edit';
}

/** Every area set, nothing above what the base role allows. */
export function clampPermissions(base: CustomBaseRole, input: Partial<Record<string, unknown>> | null | undefined): Permissions {
  const out = {} as Permissions;
  for (const area of AREAS) {
    const want = isAccessLevel(input?.[area]) ? (input![area] as AccessLevel) : 'none';
    const cap = maxLevel(base, area);
    out[area] = RANK[want] > RANK[cap] ? cap : want;
  }
  return out;
}

/** The caller's level in an area (no custom role = full access of their built-in role). */
export function levelFor(access: MyAccess | null | undefined, area: Area): AccessLevel {
  if (!access) return 'edit';
  const l = access.permissions?.[area];
  return isAccessLevel(l) ? l : 'none';
}

// ------------------------------------------------------------------
// Path → area (pages and internal APIs). First match wins, so specific
// prefixes come before general ones.
// ------------------------------------------------------------------
const PATH_RULES: { prefix: string; area: Area; exact?: boolean }[] = [
  // Pages
  { prefix: '/inbox', area: 'inbox' },
  { prefix: '/contacts', area: 'contacts' },
  { prefix: '/pipelines', area: 'pipelines' },
  { prefix: '/broadcasts', area: 'broadcasts' },
  { prefix: '/settings/templates', area: 'templates' },
  { prefix: '/carousels', area: 'templates' },
  { prefix: '/automations', area: 'automations' },
  { prefix: '/flows', area: 'flows' },
  { prefix: '/journeys', area: 'journeys' },
  { prefix: '/agents', area: 'ai_agents' },
  { prefix: '/callbacks', area: 'callbacks' },
  { prefix: '/payments', area: 'payments' },
  { prefix: '/callers', area: 'callers' },
  { prefix: '/button-clicks', area: 'button_clicks' },
  { prefix: '/failed-messages', area: 'failed_messages' },
  // APIs
  { prefix: '/api/conversations', area: 'inbox' },
  { prefix: '/api/messages', area: 'inbox' },
  { prefix: '/api/whatsapp/send', area: 'inbox' },
  { prefix: '/api/whatsapp/react', area: 'inbox' },
  { prefix: '/api/whatsapp/media', area: 'inbox' },
  { prefix: '/api/ai/draft', area: 'inbox' },
  { prefix: '/api/contacts', area: 'contacts' },
  { prefix: '/api/whatsapp/broadcast', area: 'broadcasts' },
  { prefix: '/api/whatsapp/templates', area: 'templates' },
  { prefix: '/api/carousels', area: 'templates' },
  { prefix: '/api/automations', area: 'automations' },
  { prefix: '/api/flows', area: 'flows' },
  { prefix: '/api/journeys', area: 'journeys' },
  { prefix: '/api/ai', area: 'ai_agents' },
  { prefix: '/api/language-settings', area: 'settings' },
  { prefix: '/api/callbacks', area: 'callbacks' },
  { prefix: '/api/payments', area: 'payments' },
  { prefix: '/api/callers', area: 'callers' },
  { prefix: '/api/button-clicks', area: 'button_clicks' },
  { prefix: '/api/failed-messages', area: 'failed_messages' },
  { prefix: '/api/health', area: 'failed_messages' },
  { prefix: '/api/whatsapp/config', area: 'settings' },
  { prefix: '/api/whatsapp/quality', area: 'settings' },
  { prefix: '/api/quick-replies', area: 'settings' },
  { prefix: '/api/delivery-settings', area: 'settings' },
  { prefix: '/api/account/members', area: 'members' },
  { prefix: '/api/account/invitations', area: 'members' },
  { prefix: '/api/account/roles', area: 'members' },
  { prefix: '/api/account/transfer-ownership', area: 'members' },
  { prefix: '/api/account/api-keys', area: 'api_access' },
  { prefix: '/api/account', area: 'settings', exact: true },
];

/** Secret-authenticated system calls and public hooks — never member-gated. */
const UNGATED = ['/api/automations/cron', '/api/flows/cron', '/api/journeys/hooks', '/api/whatsapp/webhook'];

/** POSTs that only read (generate / translate) — allowed with View. */
const READ_POSTS = ['/api/messages/translate', '/api/ai/draft'];

function matches(pathname: string, prefix: string, exact?: boolean): boolean {
  return pathname === prefix || (!exact && pathname.startsWith(`${prefix}/`));
}

export function areaForPath(pathname: string): Area | null {
  if (UNGATED.some((p) => matches(pathname, p))) return null;
  return PATH_RULES.find((r) => matches(pathname, r.prefix, r.exact))?.area ?? null;
}

/** Does this request change data (needs Edit)? */
export function isWriteRequest(method: string, pathname: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return false;
  return !READ_POSTS.some((p) => matches(pathname, p));
}

/**
 * Callers module level. Unlike other areas it is NOT open to every member
 * without a custom role: owners/admins manage it, everyone else only when
 * a custom role grants the 'callers' area.
 */
export function callersLevel(access: MyAccess | null | undefined, role: AccountRole | null | undefined): AccessLevel {
  if (access) return levelFor(access, 'callers');
  return role === 'owner' || role === 'admin' ? 'edit' : 'none';
}

/** Middleware verdict for a member with `access` on this request. */
export function accessVerdict(
  access: MyAccess | null | undefined,
  pathname: string,
  method: string
): { ok: true } | { ok: false; area: Area; reason: 'no_access' | 'view_only' } {
  const area = areaForPath(pathname);
  if (!area || !access) return { ok: true };
  const level = levelFor(access, area);
  if (level === 'none') return { ok: false, area, reason: 'no_access' };
  if (level === 'view' && pathname.startsWith('/api/') && isWriteRequest(method, pathname)) {
    return { ok: false, area, reason: 'view_only' };
  }
  return { ok: true };
}

/** Settings sections (?tab=) per area; personal ones are never gated. */
export const SETTINGS_SECTION_AREA: Record<string, Area | undefined> = {
  whatsapp: 'settings',
  templates: 'templates',
  'quick-replies': 'settings',
  fields: 'settings',
  deals: 'settings',
  delivery: 'settings',
  language: 'settings',
  callbacks: 'callers',
  members: 'members',
  api: 'api_access',
};

/** Starting points for a new role. */
export const ROLE_PRESETS: { key: string; base: CustomBaseRole; permissions: Partial<Permissions> }[] = [
  {
    key: 'sales',
    base: 'agent',
    permissions: { inbox: 'edit', contacts: 'edit', pipelines: 'edit', callbacks: 'edit', templates: 'view', journeys: 'view', button_clicks: 'view' },
  },
  {
    key: 'support',
    base: 'agent',
    permissions: { inbox: 'edit', contacts: 'edit', callbacks: 'edit', templates: 'view', pipelines: 'view' },
  },
  {
    key: 'marketing',
    base: 'agent',
    permissions: {
      broadcasts: 'edit', journeys: 'edit', automations: 'edit', flows: 'edit', failed_messages: 'edit',
      contacts: 'view', inbox: 'view', templates: 'view', button_clicks: 'view',
    },
  },
  {
    key: 'manager',
    base: 'viewer',
    permissions: Object.fromEntries(AREAS.filter((a) => a !== 'members' && a !== 'api_access').map((a) => [a, 'view'])) as Partial<Permissions>,
  },
];

/** True when a base role could do this level at all (for disabling UI). */
export function allowedFor(base: AccountRole, area: Area, level: AccessLevel): boolean {
  return RANK[level] <= RANK[maxLevel(base, area)] && (level !== 'edit' || hasMinRole(base, 'agent'));
}
