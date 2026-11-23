'use client';

// Admin-only Trash (migration 100): deleted callback requests or payment
// entries, with Restore and Delete forever.

import { useCallback, useEffect, useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';

interface Item {
  id: string;
  label: string | null;
  deleted_at: string;
  deleted_by_name: string | null;
}

export function TrashButton({ kind, onRestored }: { kind: 'callback' | 'payment'; onRestored: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const what = kind === 'callback' ? 'callback requests' : 'payment entries';

  const load = useCallback(async () => {
    const res = await fetch(`/api/trash?kind=${kind}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json?.error || 'Could not load the trash');
      setItems([]);
      return;
    }
    setItems(json.items ?? []);
  }, [kind]);

  useEffect(() => {
    if (open) void Promise.resolve().then(load);
  }, [open, load]);

  const act = async (it: Item, method: 'POST' | 'DELETE') => {
    if (method === 'DELETE') {
      const ok = await confirmDialog({
        title: 'Delete forever?',
        description: `“${it.label ?? 'This item'}” will be removed permanently. This cannot be undone.`,
        confirmLabel: 'Delete forever',
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(it.id);
    try {
      const res = await fetch(`/api/trash/${it.id}`, { method });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || 'Something went wrong');
        return;
      }
      toast.success(method === 'POST' ? 'Restored' : 'Deleted forever');
      await load();
      if (method === 'POST') onRestored();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Trash2 className="h-3.5 w-3.5" />
        Trash
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
          <SheetHeader className="border-b border-border bg-gradient-to-br from-rose-500/10 via-transparent to-transparent p-5">
            <SheetTitle className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-rose-500" /> Trash — {what}
            </SheetTitle>
            <SheetDescription>Deleted {what}. Only admins can see this. Restore puts an item back exactly as it was.</SheetDescription>
          </SheetHeader>
          <div className="p-5">
            {items === null ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : items.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">The trash is empty.</p>
            ) : (
              <ul className="space-y-2">
                {items.map((it) => (
                  <li key={it.id} className="rounded-xl border border-border bg-card p-3">
                    <p className="text-sm font-medium break-words text-foreground">{it.label ?? 'Deleted item'}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Deleted by {it.deleted_by_name ?? 'an admin'} · {format(new Date(it.deleted_at), 'd MMM, h:mm a')} ·{' '}
                      {formatDistanceToNow(new Date(it.deleted_at), { addSuffix: true })}
                    </p>
                    <div className="mt-2.5 flex gap-2">
                      <Button size="sm" variant="outline" disabled={busy === it.id} onClick={() => void act(it, 'POST')}>
                        {busy === it.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                        Restore
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy === it.id} onClick={() => void act(it, 'DELETE')}>
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete forever
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
