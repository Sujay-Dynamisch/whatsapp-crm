'use client';

// Note on a callback request — what the caller learned on the call.
// Shown on the Callbacks card (with who wrote it and when) so owners and
// admins can follow up.

import { useState } from 'react';
import { Eye, Loader2, PhoneCall, StickyNote } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const MAX = 500;
const QUICK = [
  'Call back after 6 PM',
  'Busy now — call tomorrow',
  'Interested, wants details on WhatsApp',
  'Asked about instalments',
  'Not interested',
  'Wrong number',
];

export function CallbackNoteDialog({
  open,
  name,
  phone,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  name: string;
  phone: string | null;
  initial: string;
  onClose: () => void;
  onSave: (note: string) => Promise<void>;
}) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const changed = text.trim() !== initial.trim();

  const addQuick = (q: string) =>
    setText((t) => {
      const base = t.trim();
      if (!base) return q;
      if (base.toLowerCase().includes(q.toLowerCase())) return t;
      return `${base}${/[.!?]$/.test(base) ? '' : '.'} ${q}`.slice(0, MAX);
    });

  const save = async () => {
    setSaving(true);
    try {
      await onSave(text.trim());
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/12 text-amber-600 dark:text-amber-400">
              <StickyNote className="size-5" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="truncate">Call note · {name}</DialogTitle>
              <DialogDescription className="flex items-center gap-1.5 text-xs">
                {phone && (
                  <>
                    <PhoneCall className="size-3" />
                    <span className="tabular-nums">{phone}</span>
                  </>
                )}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Textarea
              autoFocus
              value={text}
              maxLength={MAX}
              rows={4}
              placeholder="What happened on the call? e.g. Interested, asked to call back after 6 PM"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && changed && !saving) void save();
              }}
              className="min-h-28 resize-none pb-6"
            />
            <span
              className={cn(
                'pointer-events-none absolute bottom-2 right-3 text-[11px] tabular-nums',
                text.length > MAX - 50 ? 'text-amber-600' : 'text-muted-foreground'
              )}
            >
              {text.length}/{MAX}
            </span>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Quick add</p>
            <div className="flex flex-wrap gap-1.5">
              {QUICK.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => addQuick(q)}
                  className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground transition-colors hover:border-primary/50 hover:bg-primary/5"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>

          <p className="flex items-center gap-1.5 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <Eye className="size-3.5 shrink-0" />
            Owners and admins can see this note, with your name and the time you saved it.
          </p>
        </div>

        <DialogFooter>
          {initial && (
            <Button variant="ghost" className="mr-auto text-destructive hover:text-destructive" disabled={saving} onClick={() => setText('')}>
              Clear note
            </Button>
          )}
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || !changed} onClick={() => void save()}>
            {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Save note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
