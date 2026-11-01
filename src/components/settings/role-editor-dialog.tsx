'use client';

// Create / edit a custom role (migration 062): name, base role, and
// None / View / Edit per area. Levels above what the base role allows are
// disabled (a custom role only restricts its base role); areas whose
// feature is off for the account are marked.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import {
  ACCESS_LEVELS,
  AREAS,
  AREA_FEATURE,
  CUSTOM_BASE_ROLES,
  ROLE_PRESETS,
  VIEW_ONLY_AREAS,
  clampPermissions,
  maxLevel,
  type AccessLevel,
  type Area,
  type CustomBaseRole,
  type Permissions,
} from '@/lib/auth/permissions';
import type { CustomRole } from './custom-roles';

const RANK: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2 };

export function RoleEditorDialog({
  open,
  role,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  /** null = create */
  role: CustomRole | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const t = useTranslations('Permissions');
  const tRoles = useTranslations('Settings.roles');
  const { hasFeature } = useAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [base, setBase] = useState<CustomBaseRole>('agent');
  const [perms, setPerms] = useState<Permissions>(() => clampPermissions('agent', {}));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(role?.name ?? '');
    setDescription(role?.description ?? '');
    setBase(role?.base_role ?? 'agent');
    setPerms(clampPermissions(role?.base_role ?? 'agent', role?.permissions ?? ROLE_PRESETS[0].permissions));
  }, [open, role]);

  const changeBase = (b: CustomBaseRole) => {
    setBase(b);
    setPerms((p) => clampPermissions(b, p));
  };
  const applyPreset = (key: string) => {
    const p = ROLE_PRESETS.find((x) => x.key === key)!;
    setBase(p.base);
    setPerms(clampPermissions(p.base, p.permissions));
    if (!name.trim()) setName(t(`presets.${key}`));
  };
  const setAll = (level: AccessLevel) => setPerms(clampPermissions(base, Object.fromEntries(AREAS.map((a) => [a, level]))));

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(role ? `/api/account/roles/${role.id}` : '/api/account/roles', {
        method: role ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, base_role: base, permissions: perms }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || t('saveFailed'));
        return;
      }
      toast.success(role ? t('roleUpdated', { name: name.trim() }) : t('roleCreated', { name: name.trim() }));
      onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto bg-popover border-border sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{role ? t('editRole', { name: role.name }) : t('newRole')}</DialogTitle>
          <DialogDescription>{t('editorDesc')}</DialogDescription>
        </DialogHeader>

        {!role && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{t('startFrom')}</span>
            {ROLE_PRESETS.map((p) => (
              <Button key={p.key} type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => applyPreset(p.key)}>
                {t(`presets.${p.key}`)}
              </Button>
            ))}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t('name')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t('namePlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('baseRole')}</Label>
            <div className="flex gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
              {CUSTOM_BASE_ROLES.map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => changeBase(b)}
                  className={cn(
                    'flex-1 rounded-md px-2 py-1.5 text-xs font-medium',
                    base === b ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {tRoles(b)}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">{t(`baseHint.${base}`)}</p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>
              {t('description')} <span className="text-muted-foreground">({t('optional')})</span>
            </Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} rows={2} placeholder={t('descriptionPlaceholder')} />
          </div>
        </div>

        <div className="rounded-xl border border-border">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <p className="text-sm font-medium">{t('accessTitle')}</p>
            <div className="flex gap-1">
              {ACCESS_LEVELS.map((l) => (
                <Button key={l} type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAll(l)}>
                  {t('allTo', { level: t(`levels.${l}`) })}
                </Button>
              ))}
            </div>
          </div>
          <ul className="divide-y divide-border">
            {AREAS.map((area: Area) => {
              const feature = AREA_FEATURE[area];
              const featureOff = feature ? !hasFeature(feature) : false;
              const cap = maxLevel(base, area);
              return (
                <li key={area} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {t(`areas.${area}.label`)}
                      {featureOff && <span className="ml-2 text-[10px] font-normal text-muted-foreground">({t('featureOff')})</span>}
                    </p>
                    <p className="text-[11px] text-muted-foreground">{t(`areas.${area}.desc`)}</p>
                  </div>
                  <div className="flex shrink-0 gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5" role="radiogroup" aria-label={t(`areas.${area}.label`)}>
                    {ACCESS_LEVELS.filter((l) => l !== 'edit' || !VIEW_ONLY_AREAS.includes(area)).map((l) => {
                      const disabled = RANK[l] > RANK[cap];
                      return (
                        <button
                          key={l}
                          type="button"
                          role="radio"
                          aria-checked={perms[area] === l}
                          disabled={disabled}
                          title={disabled ? t('aboveBase', { base: tRoles(base) }) : undefined}
                          onClick={() => setPerms((p) => ({ ...p, [area]: l }))}
                          className={cn(
                            'w-16 rounded-md px-2 py-1 text-xs font-medium',
                            perms[area] === l
                              ? l === 'none'
                                ? 'bg-background text-muted-foreground shadow-sm'
                                : l === 'view'
                                  ? 'bg-sky-500/15 text-sky-700 shadow-sm dark:text-sky-300'
                                  : 'bg-emerald-500/15 text-emerald-700 shadow-sm dark:text-emerald-300'
                              : 'text-muted-foreground hover:text-foreground',
                            disabled && 'cursor-not-allowed opacity-40 hover:text-muted-foreground'
                          )}
                        >
                          {t(`levels.${l}`)}
                        </button>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={saving || !name.trim()}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {role ? t('save') : t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
