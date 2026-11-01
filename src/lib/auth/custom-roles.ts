// ============================================================
// Custom roles — validation for the roles API (migration 062). Pure.
// ============================================================

import { CUSTOM_BASE_ROLES, clampPermissions, type CustomBaseRole, type Permissions } from './permissions';

export interface RoleInput {
  name: string;
  description: string | null;
  base_role: CustomBaseRole;
  permissions: Permissions;
}

/** Parse a create / update body. `partial` (PATCH) keeps missing fields. */
export function parseRoleInput(
  body: unknown,
  current?: RoleInput
): { ok: true; value: RoleInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = b.name === undefined && current ? current.name : typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return { ok: false, error: 'Give the role a name' };
  if (name.length > 60) return { ok: false, error: 'Role names are at most 60 characters' };
  if (['owner', 'admin', 'agent', 'viewer'].includes(name.toLowerCase())) {
    return { ok: false, error: 'That name is used by a built-in role — choose another' };
  }
  const rawDesc = b.description === undefined && current ? current.description : b.description;
  const description = typeof rawDesc === 'string' && rawDesc.trim() ? rawDesc.trim() : null;
  if (description && description.length > 300) return { ok: false, error: 'Description is at most 300 characters' };
  const base = (b.base_role === undefined && current ? current.base_role : b.base_role) as CustomBaseRole;
  if (!CUSTOM_BASE_ROLES.includes(base)) return { ok: false, error: "Base role must be admin, agent or viewer" };
  const rawPerms = b.permissions === undefined && current ? current.permissions : b.permissions;
  if (!rawPerms || typeof rawPerms !== 'object' || Array.isArray(rawPerms)) return { ok: false, error: 'Set the permissions' };
  const permissions = clampPermissions(base, rawPerms as Record<string, unknown>);
  if (!Object.values(permissions).some((l) => l !== 'none')) {
    return { ok: false, error: 'Give the role access to at least one area' };
  }
  return { ok: true, value: { name, description, base_role: base, permissions } };
}
