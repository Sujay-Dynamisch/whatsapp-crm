'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, ToggleRight } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { FEATURE_INFO, FEATURES, isFeatureEnabled, type Feature } from '@/lib/features';

interface AccountFeaturesDialogProps {
  accountId: string | null;
  accountName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * System-admin control for which features a customer account gets
 * (migration 045). Saves the full disabled list in one PUT.
 */
export function AccountFeaturesDialog({
  accountId,
  accountName,
  open,
  onOpenChange,
}: AccountFeaturesDialogProps) {
  const [disabled, setDisabled] = useState<Feature[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/admin/accounts/${accountId}/features`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          toast.error(data?.error || `Failed to load features (HTTP ${res.status})`);
          return;
        }
        setDisabled(data.disabled_features ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, accountId]);

  function toggle(feature: Feature, on: boolean) {
    setDisabled((prev) => (on ? prev.filter((f) => f !== feature) : [...prev, feature]));
  }

  async function save() {
    if (!accountId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/accounts/${accountId}/features`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled_features: disabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || `Failed to save (HTTP ${res.status})`);
        return;
      }
      setDisabled(data.disabled_features ?? []);
      toast.success(`Features updated for ${accountName}`);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  // Parent of a feature, if a switched-off parent is what's blocking it.
  const blockedBy = (feature: Feature): Feature | undefined =>
    FEATURES.find(
      (parent) => FEATURE_INFO[parent].implies?.includes(feature) && disabled.includes(parent)
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <ToggleRight className="h-5 w-5 text-primary" />
            Manage Features
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Choose what <span className="font-medium text-popover-foreground">{accountName}</span>{' '}
            can use. Dashboard, Inbox, Contacts and Settings are always available.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
            {FEATURES.map((feature) => {
              const parent = blockedBy(feature);
              const on = isFeatureEnabled(disabled, feature);
              return (
                <div
                  key={feature}
                  className="flex items-center justify-between gap-4 rounded-md border border-border p-3"
                >
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {FEATURE_INFO[feature].label}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {parent
                        ? `Off because ${FEATURE_INFO[parent].label} is off.`
                        : FEATURE_INFO[feature].description}
                    </p>
                  </div>
                  <Switch
                    aria-label={FEATURE_INFO[feature].label}
                    checked={on}
                    disabled={saving || Boolean(parent)}
                    onCheckedChange={(checked) => toggle(feature, checked)}
                  />
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || loading || !accountId}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
