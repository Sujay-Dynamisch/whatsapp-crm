'use client';

// Move all open leads at once (e.g. a caller resigned): from one caller
// or Admin Unassigned → one caller, shared evenly, or Admin Unassigned.

import { useState } from 'react';
import { ArrowRightLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export interface BulkCaller {
  id: string;
  name: string;
  leads: number;
  active: boolean;
}

const SELECT =
  'flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50';

export function BulkMoveDialog({
  callers,
  unassigned,
  onDone,
}: {
  callers: BulkCaller[];
  unassigned: number;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('round_robin');
  const [busy, setBusy] = useState(false);

  const count = from === 'unassigned' ? unassigned : (callers.find((c) => c.id === from)?.leads ?? 0);
  const activeTargets = callers.filter((c) => c.active && c.id !== from);

  const move = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/callers/reassign-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not move the leads');
      toast.success(`Moved ${d.moved} lead${d.moved === 1 ? '' : 's'}`);
      setOpen(false);
      setFrom('');
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not move the leads');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />
        Bulk move leads
      </Button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move leads in bulk</DialogTitle>
            <DialogDescription>
              Move every open lead (with its callbacks) at once — e.g. when a caller leaves. Each new owner gets one notification.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Move all leads of</span>
              <select className={SELECT} value={from} disabled={busy} onChange={(e) => setFrom(e.target.value)}>
                <option value="">Choose…</option>
                <option value="unassigned">Admin Unassigned ({unassigned})</option>
                {callers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.leads}){c.active ? '' : ' · inactive'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">To</span>
              <select className={SELECT} value={to} disabled={busy || !from} onChange={(e) => setTo(e.target.value)}>
                <option value="round_robin">Share evenly across active callers</option>
                {activeTargets.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                {from !== 'unassigned' && <option value="unassigned">Admin Unassigned</option>}
              </select>
            </label>
            {from && (
              <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                {count === 0 ? 'Nothing to move.' : `${count} lead${count === 1 ? '' : 's'} will be moved.`}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !from || count === 0} onClick={() => void move()}>
              {busy && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              Move {count > 0 ? count : ''} lead{count === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
