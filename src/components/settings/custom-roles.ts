// Custom roles on the client (migration 062): shared types + helpers for
// the Team tab, the role editor and the invite dialog.

import type { AccountRole } from '@/lib/auth/roles';
import type { CustomBaseRole, Permissions } from '@/lib/auth/permissions';

export interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  base_role: CustomBaseRole;
  permissions: Permissions;
  member_count?: number;
  invite_count?: number;
}

/** Select value for a role choice: built-in key or "custom:<id>". */
export type RoleChoice = AccountRole | `custom:${string}`;

export const choiceFor = (role: AccountRole, customRoleId?: string | null): RoleChoice =>
  customRoleId ? `custom:${customRoleId}` : role;

export function parseChoice(choice: string): { role: AccountRole } | { custom_role_id: string } {
  return choice.startsWith('custom:') ? { custom_role_id: choice.slice(7) } : { role: choice as AccountRole };
}

export async function loadCustomRoles(): Promise<{ roles: CustomRole[]; available: boolean }> {
  const res = await fetch('/api/account/roles', { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) return { roles: [], available: false };
  const json = (await res.json()) as { roles?: CustomRole[]; available?: boolean };
  return { roles: json.roles ?? [], available: json.available !== false };
}
