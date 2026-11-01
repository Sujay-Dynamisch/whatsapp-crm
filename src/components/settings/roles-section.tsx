'use client';

// Team tab → Roles (migration 062): the account's custom roles, who uses
// them, and what each can do. Admins with Edit on "Team & roles" create,
// edit and delete them; everyone else sees the list read-only.

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { AREAS, type Area } from '@/lib/auth/permissions';
import type { CustomRole } from './custom-roles';
import { RoleEditorDialog } from './role-editor-dialog';

export function RolesSection({ roles, canEdit, onChanged }: { roles: CustomRole[]; canEdit: boolean; onChanged: () => void }) {
  const t = useTranslations('Permissions');
  const tRoles = useTranslations('Settings.roles');
  const [editing, setEditing] = useState<CustomRole | null>(null);
  const [open, setOpen] = useState(false);

  async function remove(role: CustomRole) {
    if (!(await confirmDialog({ title: t('deleteConfirm', { name: role.name }), action: 'delete' }))) return;
    const res = await fetch(`/api/account/roles/${role.id}`, { method: 'DELETE' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json?.error || t('deleteFailed'));
      return;
    }
    toast.success(t('roleDeleted', { name: role.name }));
    onChanged();
  }

  const summary = (role: CustomRole, level: 'edit' | 'view') =>
    AREAS.filter((a: Area) => role.permissions?.[a] === level).map((a) => t(`areas.${a}.label`));

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <ShieldCheck className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">{t('rolesTitle')}</h3>
        <Badge className="bg-muted text-muted-foreground border-border">{roles.length}</Badge>
        {canEdit && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            <Plus className="size-4" />
            {t('newRole')}
          </Button>
        )}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('rolesHint')}</p>

      {roles.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">{t('noRoles')}</CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {roles.map((role) => {
                const edit = summary(role, 'edit');
                const view = summary(role, 'view');
                return (
                  <li key={role.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{role.name}</span>
                        <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {t('basedOn', { base: tRoles(role.base_role) })}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {t('usage', { members: role.member_count ?? 0, invites: role.invite_count ?? 0 })}
                        </span>
                      </div>
                      {role.description && <p className="mt-0.5 text-xs text-muted-foreground">{role.description}</p>}
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {edit.length > 0 && (
                          <>
                            <span className="font-medium text-emerald-600 dark:text-emerald-400">{t('levels.edit')}:</span> {edit.join(', ')}
                          </>
                        )}
                        {edit.length > 0 && view.length > 0 && ' · '}
                        {view.length > 0 && (
                          <>
                            <span className="font-medium text-sky-600 dark:text-sky-400">{t('levels.view')}:</span> {view.join(', ')}
                          </>
                        )}
                      </p>
                    </div>
                    {canEdit && (
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditing(role);
                            setOpen(true);
                          }}
                        >
                          <Pencil className="size-3.5" />
                          {t('edit')}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={t('delete')}
                          className="border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20"
                          onClick={() => void remove(role)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <RoleEditorDialog open={open} role={editing} onOpenChange={setOpen} onSaved={onChanged} />
    </div>
  );
}
