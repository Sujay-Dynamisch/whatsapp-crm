import { describe, expect, it } from 'vitest';

import {
  AREAS,
  ROLE_PRESETS,
  SETTINGS_SECTION_AREA,
  accessVerdict,
  areaForPath,
  clampPermissions,
  isWriteRequest,
  levelFor,
  maxLevel,
  parseAccess,
  type MyAccess,
} from './permissions';
import { parseRoleInput } from './custom-roles';
import { FEATURES } from '../features';
import fs from 'node:fs';
import path from 'node:path';

const access = (permissions: Record<string, string>, base: MyAccess['base_role'] = 'agent'): MyAccess => ({
  custom_role_id: 'r1',
  name: 'Sales',
  base_role: base,
  permissions: permissions as MyAccess['permissions'],
});

describe('levels', () => {
  it('no custom role = full access; missing area = none', () => {
    expect(levelFor(null, 'broadcasts')).toBe('edit');
    expect(levelFor(access({ inbox: 'view' }), 'inbox')).toBe('view');
    expect(levelFor(access({ inbox: 'view' }), 'broadcasts')).toBe('none');
    expect(levelFor(access({ inbox: 'bogus' }), 'inbox')).toBe('none');
  });

  it('a custom role only restricts its base role', () => {
    expect(maxLevel('viewer', 'inbox')).toBe('view');
    expect(maxLevel('agent', 'inbox')).toBe('edit');
    expect(maxLevel('agent', 'settings')).toBe('view');
    expect(maxLevel('agent', 'members')).toBe('view');
    expect(maxLevel('admin', 'members')).toBe('edit');
    const viewer = clampPermissions('viewer', { inbox: 'edit', contacts: 'view', broadcasts: 'none' });
    expect(viewer).toMatchObject({ inbox: 'view', contacts: 'view', broadcasts: 'none' });
    const agent = clampPermissions('agent', { settings: 'edit', members: 'edit', inbox: 'edit', junk: 'edit' });
    expect(agent).toMatchObject({ settings: 'view', members: 'view', inbox: 'edit' });
    expect(Object.keys(agent).sort()).toEqual([...AREAS].sort()); // every area, nothing else
    expect(agent.broadcasts).toBe('none'); // unset → none
  });

  it('presets stay within their base role', () => {
    for (const p of ROLE_PRESETS) expect(clampPermissions(p.base, p.permissions), p.key).toMatchObject(p.permissions);
  });
});

describe('paths', () => {
  it('pages and APIs map to their area; specific before general', () => {
    expect(areaForPath('/inbox')).toBe('inbox');
    expect(areaForPath('/settings/templates/new-carousel')).toBe('templates');
    expect(areaForPath('/settings')).toBeNull(); // personal sections stay reachable
    expect(areaForPath('/api/ai/draft')).toBe('inbox');
    expect(areaForPath('/api/ai/config')).toBe('ai_agents');
    expect(areaForPath('/api/account')).toBe('settings');
    expect(areaForPath('/api/account/roles/abc')).toBe('members');
    expect(areaForPath('/api/account/api-keys')).toBe('api_access');
    expect(areaForPath('/dashboard')).toBeNull();
    expect(areaForPath('/notifications')).toBeNull();
    expect(areaForPath('/inboxes')).toBeNull(); // prefix needs a path boundary
  });

  it('system endpoints are never member-gated', () => {
    for (const p of ['/api/automations/cron', '/api/flows/cron', '/api/journeys/hooks/tok', '/api/whatsapp/webhook']) {
      expect(areaForPath(p), p).toBeNull();
    }
  });

  it('writes vs reads', () => {
    expect(isWriteRequest('GET', '/api/contacts')).toBe(false);
    expect(isWriteRequest('POST', '/api/contacts')).toBe(true);
    expect(isWriteRequest('DELETE', '/api/contacts/x')).toBe(true);
    expect(isWriteRequest('POST', '/api/messages/translate')).toBe(false);
  });

  it('verdicts', () => {
    const a = access({ contacts: 'view', inbox: 'edit' });
    expect(accessVerdict(a, '/contacts', 'GET')).toEqual({ ok: true });
    expect(accessVerdict(a, '/api/contacts', 'PATCH')).toEqual({ ok: false, area: 'contacts', reason: 'view_only' });
    expect(accessVerdict(a, '/broadcasts', 'GET')).toEqual({ ok: false, area: 'broadcasts', reason: 'no_access' });
    expect(accessVerdict(a, '/api/whatsapp/send', 'POST')).toEqual({ ok: true });
    expect(accessVerdict(null, '/api/contacts', 'DELETE')).toEqual({ ok: true });
  });

  it('every settings section with an area points at a real area', () => {
    for (const a of Object.values(SETTINGS_SECTION_AREA)) expect(AREAS).toContain(a);
  });
});

describe('parseAccess', () => {
  it('reads my_permissions() and ignores anything else', () => {
    expect(parseAccess(null)).toBeNull();
    expect(parseAccess([])).toBeNull();
    expect(parseAccess({ name: 'x' })).toBeNull();
    expect(parseAccess({ custom_role_id: 'r', name: 'Sales', base_role: 'agent', permissions: { inbox: 'edit' } })).toEqual({
      custom_role_id: 'r',
      name: 'Sales',
      base_role: 'agent',
      permissions: { inbox: 'edit' },
    });
    expect(parseAccess({ custom_role_id: 'r', base_role: 'owner', permissions: {} })!.base_role).toBe('viewer');
  });
});

describe('parseRoleInput', () => {
  const ok = { name: '  Sales agent ', base_role: 'agent', permissions: { inbox: 'edit', settings: 'edit' } };
  it('normalises, clamps and requires some access', () => {
    const r = parseRoleInput(ok);
    expect(r.ok && r.value).toMatchObject({ name: 'Sales agent', description: null, base_role: 'agent' });
    expect(r.ok && r.value.permissions).toMatchObject({ inbox: 'edit', settings: 'view' });
    expect(parseRoleInput({ ...ok, name: '' })).toMatchObject({ ok: false });
    expect(parseRoleInput({ ...ok, name: 'Admin' })).toMatchObject({ ok: false });
    expect(parseRoleInput({ ...ok, base_role: 'owner' })).toMatchObject({ ok: false });
    expect(parseRoleInput({ ...ok, permissions: {} })).toMatchObject({ ok: false, error: 'Give the role access to at least one area' });
    expect(parseRoleInput({ ...ok, permissions: [] })).toMatchObject({ ok: false });
  });
  it('PATCH keeps what isn’t sent; a new base role re-clamps', () => {
    const current = (parseRoleInput(ok) as { ok: true; value: Parameters<typeof parseRoleInput>[1] & object }).value;
    const r = parseRoleInput({ base_role: 'viewer' }, current);
    expect(r.ok && r.value).toMatchObject({ name: 'Sales agent', base_role: 'viewer' });
    expect(r.ok && r.value.permissions.inbox).toBe('view');
  });
});

describe('database contract', () => {
  it('migration 079 (and later area additions) gates every area that has tables, using the same keys', () => {
    // 079 plus later migrations that add areas in the same (table, area, gate) shape.
    const dir = path.resolve(__dirname, '../../../supabase/migrations');
    const sql = fs
      .readdirSync(dir)
      .filter((f) => f >= '079_' && f.endsWith('.sql'))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    const used = new Set([...sql.matchAll(/\('[a-z_]+',\s+'([a-z_]+)',\s+(?:true|false)\)/g)].map((m) => m[1]));
    for (const a of used) expect(AREAS, a).toContain(a);
    for (const a of AREAS) expect(used, a).toContain(a);
  });
  it('areas tied to features use real feature keys', async () => {
    const { AREA_FEATURE } = await import('./permissions');
    for (const f of Object.values(AREA_FEATURE)) expect(FEATURES).toContain(f);
  });
});
